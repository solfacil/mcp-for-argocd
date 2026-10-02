import {
  ApplicationLogEntry,
  V1alpha1Application,
  V1alpha1ApplicationList,
  V1alpha1ApplicationTree,
  V1EventList,
  V1alpha1ResourceAction,
  V1alpha1ResourceDiff,
  V1alpha1ResourceResult,
  V1alpha1ApplicationResourceResult,
  V1alpha1ClusterList,
  V1alpha1AppProject
} from '../types/argocd-types.js';
import { HttpClient } from './http.js';

// Strips the fields that dominate response size without carrying diagnostic
// value for an LLM: metadata.managedFields (per-manager field-ownership
// bookkeeping — one block per apply/update, can be tens of KB on its own)
// and the kubectl last-applied-configuration annotation (duplicates the
// whole spec as an escaped JSON string). Mutates nothing; returns a new
// object with the same shape minus those fields. Safe to call on any
// Kubernetes-shaped object (Application, or a resource manifest inside
// targetState/liveState).
export function stripManagedFields<T extends { metadata?: unknown }>(obj: T): T {
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  if (!metadata) return obj;

  const newMetadata: Record<string, unknown> = { ...metadata };
  delete newMetadata.managedFields;

  const annotations = newMetadata.annotations as Record<string, unknown> | undefined;
  if (annotations && 'kubectl.kubernetes.io/last-applied-configuration' in annotations) {
    const newAnnotations = { ...annotations };
    delete newAnnotations['kubectl.kubernetes.io/last-applied-configuration'];
    newMetadata.annotations = Object.keys(newAnnotations).length > 0 ? newAnnotations : undefined;
  }

  return { ...obj, metadata: newMetadata };
}

export class ArgoCDClient {
  private baseUrl: string;
  private apiToken: string;
  private client: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.client = new HttpClient(this.baseUrl, this.apiToken);
  }

  public async listApplications(params?: { search?: string; limit?: number; offset?: number }) {
    // ArgoCD's /api/v1/applications has no substring-search query param (only
    // exact `name`, `project`, `repo`, `appNamespace`, `selector`) — sending
    // `search` as a query param is silently ignored by the server, which
    // returns every application unfiltered. The partial-match behavior this
    // method documents has to be done client-side instead.
    const { body } = await this.client.get<V1alpha1ApplicationList>(`/api/v1/applications`);

    const rawItems = params?.search
      ? (body.items ?? []).filter((app) =>
          app.metadata?.name?.toLowerCase().includes(params.search!.toLowerCase())
        )
      : (body.items ?? []);

    // Strip heavy fields to reduce token usage
    const strippedItems =
      rawItems.map((app) => ({
        metadata: {
          name: app.metadata?.name,
          namespace: app.metadata?.namespace,
          labels: app.metadata?.labels,
          creationTimestamp: app.metadata?.creationTimestamp
        },
        spec: {
          project: app.spec?.project,
          source: app.spec?.source,
          destination: app.spec?.destination
        },
        status: {
          sync: app.status?.sync,
          health: app.status?.health,
          summary: app.status?.summary
        }
      })) ?? [];

    // Apply pagination. Defaults to 50 when the caller doesn't pass limit —
    // this instance manages 600+ applications across every repo/org, so an
    // unbounded call here is as large as get_application used to be before
    // managedFields was stripped.
    const start = params?.offset ?? 0;
    const limit = params?.limit ?? 25;
    const end = start + limit;
    const items = strippedItems.slice(start, end);

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        totalItems: strippedItems.length,
        returnedItems: items.length,
        hasMore: end < strippedItems.length
      }
    };
  }

  public async listClusters(params?: { server?: string; name?: string }) {
    const queryParams: Record<string, string> = {};
    if (params?.server) queryParams.server = params.server;
    if (params?.name) queryParams.name = params.name;

    const { body } = await this.client.get<V1alpha1ClusterList>(
      `/api/v1/clusters`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    return body;
  }

  public async getApplication(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      queryParams
    );
    return stripManagedFields(body);
  }

  public async getAppProject(projectName: string) {
    const { body } = await this.client.get<V1alpha1AppProject>(`/api/v1/projects/${projectName}`);
    return body;
  }

  public async createApplication(application: V1alpha1Application) {
    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications`,
      null,
      application
    );
    return body;
  }

  public async updateApplication(applicationName: string, application: V1alpha1Application) {
    const { body } = await this.client.put<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      null,
      application
    );
    return body;
  }

  public async deleteApplication(
    applicationName: string,
    options?: {
      appNamespace?: string;
      cascade?: boolean;
      propagationPolicy?: string;
    }
  ) {
    const queryParams: Record<string, string | boolean> = {};

    if (options?.appNamespace) {
      queryParams.appNamespace = options.appNamespace;
    }
    if (options?.cascade !== undefined) {
      queryParams.cascade = options.cascade;
    }
    if (options?.propagationPolicy) {
      queryParams.propagationPolicy = options.propagationPolicy;
    }

    const { body } = await this.client.delete<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );
    return body;
  }

  public async syncApplication(
    applicationName: string,
    options?: {
      appNamespace?: string;
      dryRun?: boolean;
      prune?: boolean;
      revision?: string;
      syncOptions?: string[];
    }
  ) {
    const syncRequest: Record<string, string | boolean | string[]> = {};

    if (options?.appNamespace) {
      syncRequest.appNamespace = options.appNamespace;
    }
    if (options?.dryRun !== undefined) {
      syncRequest.dryRun = options.dryRun;
    }
    if (options?.prune !== undefined) {
      syncRequest.prune = options.prune;
    }
    if (options?.revision) {
      syncRequest.revision = options.revision;
    }
    if (options?.syncOptions) {
      syncRequest.syncOptions = options.syncOptions;
    }

    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications/${applicationName}/sync`,
      null,
      Object.keys(syncRequest).length > 0 ? syncRequest : undefined
    );
    return body;
  }

  public async getApplicationResourceTree(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1ApplicationTree>(
      `/api/v1/applications/${applicationName}/resource-tree`,
      queryParams
    );
    return body;
  }

  public async getApplicationManagedResources(
    applicationName: string,
    filters?: {
      namespace?: string;
      name?: string;
      version?: string;
      group?: string;
      kind?: string;
      appNamespace?: string;
      project?: string;
    }
  ) {
    const { body } = await this.client.get<{ items: V1alpha1ResourceDiff[] }>(
      `/api/v1/applications/${applicationName}/managed-resources`,
      filters
    );

    // Each item nests up to 4 full K8s manifests (targetState, liveState,
    // normalizedLiveState, predictedLiveState) — managedFields on each one
    // was the dominant cost here, not the resource count.
    const items = (body.items ?? []).map((item) => ({
      ...item,
      targetState: item.targetState ? stripManagedFields(JSON.parse(item.targetState)) : undefined,
      liveState: item.liveState ? stripManagedFields(JSON.parse(item.liveState)) : undefined,
      normalizedLiveState: item.normalizedLiveState
        ? stripManagedFields(JSON.parse(item.normalizedLiveState))
        : undefined,
      predictedLiveState: item.predictedLiveState
        ? stripManagedFields(JSON.parse(item.predictedLiveState))
        : undefined
    }));

    return { ...body, items };
  }

  public async getApplicationLogs(applicationName: string) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getWorkloadLogs(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    container: string
  ) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/logs`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version,
        follow: false,
        tailLines: 100,
        container: container
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getPodLogs(applicationName: string, podName: string) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/pods/${podName}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getApplicationEvents(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1EventList>(
      `/api/v1/applications/${applicationName}/events`,
      queryParams
    );
    return body;
  }

  public async getResource(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const { body } = await this.client.get<V1alpha1ApplicationResourceResult>(
      `/api/v1/applications/${applicationName}/resource`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      }
    );
    return body.manifest;
  }

  public async getResourceEvents(
    applicationName: string,
    applicationNamespace: string,
    resourceUID: string,
    resourceNamespace: string,
    resourceName: string
  ) {
    const { body } = await this.client.get<V1EventList>(
      `/api/v1/applications/${applicationName}/events`,
      {
        appNamespace: applicationNamespace,
        resourceNamespace,
        resourceUID,
        resourceName
      }
    );
    return body;
  }

  public async getResourceActions(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const { body } = await this.client.get<{ actions: V1alpha1ResourceAction[] }>(
      `/api/v1/applications/${applicationName}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      }
    );
    return body;
  }

  public async runResourceAction(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    action: string
  ) {
    const { body } = await this.client.post<string, V1alpha1Application>(
      `/api/v1/applications/${applicationName}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      action
    );
    return body;
  }
}
