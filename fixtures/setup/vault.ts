// Vitest setup: every test file starts with an empty in-memory vault for secrets.
import { beforeEach } from 'vitest';
import { memoryVault, setVault } from '../../packages/engine/src/secrets';

beforeEach(() => setVault(memoryVault()));
