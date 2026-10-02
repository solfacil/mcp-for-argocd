import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripManagedFields } from './client.js';

// --- stripManagedFields ---------------------------------------------------
//
// Fixes #59: list_applications already stripped heavy fields before
// returning, but get_application and get_application_managed_resources
// didn't, so a single Application or resource manifest could still carry
// its full managedFields history (one block per apply/update — observed in
// the wild at ~1MB for a single application) straight into model context.

test('removes metadata.managedFields', () => {
  const input = {
    metadata: {
      name: 'bifrost',
      managedFields: [{ manager: 'argocd-controller', operation: 'Update' }]
    }
  };
  const result = stripManagedFields(input);
  assert.equal(result.metadata.name, 'bifrost');
  assert.equal('managedFields' in result.metadata, false);
});

test('removes the kubectl last-applied-configuration annotation but keeps other annotations', () => {
  const input = {
    metadata: {
      name: 'bifrost',
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"apiVersion":"v1", ...}',
        'argocd.argoproj.io/tracking-id': 'apps:Deployment:ai-apps/bifrost'
      }
    }
  };
  const result = stripManagedFields(input);
  assert.equal(
    'kubectl.kubernetes.io/last-applied-configuration' in (result.metadata.annotations ?? {}),
    false
  );
  assert.equal(
    result.metadata.annotations?.['argocd.argoproj.io/tracking-id'],
    'apps:Deployment:ai-apps/bifrost'
  );
});

test('drops the annotations key entirely when it becomes empty', () => {
  const input = {
    metadata: {
      name: 'bifrost',
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{}'
      }
    }
  };
  const result = stripManagedFields(input);
  assert.equal(result.metadata.annotations, undefined);
});

test('is a no-op for objects without metadata', () => {
  const input: { spec: { project: string }; metadata?: unknown } = {
    spec: { project: 'default' }
  };
  const result = stripManagedFields(input);
  assert.deepEqual(result, input);
});

test('does not mutate the input object', () => {
  const input = {
    metadata: {
      name: 'bifrost',
      managedFields: [{ manager: 'argocd-controller' }]
    }
  };
  stripManagedFields(input);
  assert.equal('managedFields' in input.metadata, true);
});
