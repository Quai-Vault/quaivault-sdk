import { describe, expect, it } from 'vitest';
import { getZoneForAddress, isQiAddress } from 'quais';
import {
  assertQuaiAddress,
  assertQuaiAddresses,
  inspectAddress,
  isUsableQuaiAddress,
} from '../src/address.js';
import { ValidationError } from '../src/errors/index.js';
import { connect } from '../src/client.js';

// Zone is the first byte; the ledger is the 9th bit — the high bit of the second byte.
const QUAI_C1 = '0x0011111111111111111111111111111111111111'; // zone 0x00, Quai
const QUAI_P1 = '0x1011111111111111111111111111111111111111'; // zone 0x10, Quai
const QI_C1 = '0x0081111111111111111111111111111111111111'; //  zone 0x00, Qi
const QI_HIGH = '0x00F1111111111111111111111111111111111111'; // zone 0x00, Qi
const NO_ZONE = '0x7E11111111111111111111111111111111111111'; // no zone, Quai ledger

describe('the two independent address properties', () => {
  it('confirms zone and ledger are orthogonal', () => {
    // This is why a zone check alone is insufficient: QI_C1 sits in a real zone but
    // is on the UTXO ledger, and NO_ZONE is Quai-ledger but in no shard.
    expect(getZoneForAddress(QI_C1)).toBe('0x00');
    expect(isQiAddress(QI_C1)).toBe(true);

    expect(getZoneForAddress(NO_ZONE)).toBeNull();
    expect(isQiAddress(NO_ZONE)).toBe(false);
  });
});

describe('inspectAddress', () => {
  it('accepts Quai-ledger addresses in valid zones', () => {
    for (const [addr, zone] of [
      [QUAI_C1, '0x00'],
      [QUAI_P1, '0x10'],
    ] as const) {
      const r = inspectAddress(addr);
      expect(r.valid, addr).toBe(true);
      expect(r.zone).toBe(zone);
      expect(r.ledger).toBe('quai');
    }
  });

  it('rejects Qi addresses even when the zone is valid', () => {
    for (const addr of [QI_C1, QI_HIGH]) {
      const r = inspectAddress(addr);
      expect(r.valid, addr).toBe(false);
      expect(r.ledger).toBe('qi');
      expect(r.zone).toBe('0x00');
      expect(r.reason).toMatch(/Qi-ledger/);
    }
  });

  it('rejects addresses outside every zone prefix', () => {
    const r = inspectAddress(NO_ZONE);
    expect(r.valid).toBe(false);
    expect(r.zone).toBeUndefined();
    expect(r.reason).toMatch(/no Quai shard/);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'nope', '0x1234', null, undefined, 42]) {
      expect(inspectAddress(bad).valid, String(bad)).toBe(false);
    }
  });

  it('returns a checksummed address for valid input', () => {
    expect(inspectAddress(QUAI_C1).checksummed).toBe(QUAI_C1);
  });
});

describe('assertQuaiAddress', () => {
  it('returns the checksummed address when valid', () => {
    expect(assertQuaiAddress(QUAI_C1, 'owner')).toBe(QUAI_C1);
  });

  it('names the field and explains the ledger rule for a Qi address', () => {
    try {
      assertQuaiAddress(QI_C1, 'guardian');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as ValidationError;
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toContain('guardian');
      expect(err.message).toMatch(/Qi-ledger/);
      expect(err.remediation).toMatch(/UTXO ledger|9th bit/);
    }
  });

  it('explains the zone rule for a zone-less address', () => {
    try {
      assertQuaiAddress(NO_ZONE, 'owner');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ValidationError).remediation).toMatch(/0x00–0x02/);
    }
  });

  it('reports the offending index in a list', () => {
    expect(() => assertQuaiAddresses([QUAI_C1, QI_C1], 'owners')).toThrow(/owners\[1\]/);
    expect(assertQuaiAddresses([QUAI_C1, QUAI_P1], 'owners')).toHaveLength(2);
  });
});

describe('isUsableQuaiAddress', () => {
  it('is true only for shard-valid Quai-ledger addresses', () => {
    expect(isUsableQuaiAddress(QUAI_C1)).toBe(true);
    expect(isUsableQuaiAddress(QUAI_P1)).toBe(true);
    expect(isUsableQuaiAddress(QI_C1)).toBe(false);
    expect(isUsableQuaiAddress(NO_ZONE)).toBe(false);
    expect(isUsableQuaiAddress('garbage')).toBe(false);
  });
});

describe('Qi addresses are rejected at every entry point that commits a role or value', () => {
  const qv = connect({ network: 'mainnet', useEnv: false });
  const vault = qv.vault('0x006edB94806eC870E3E5d884649C7589AA432950');

  it('rejects a Qi vault address outright', () => {
    expect(() => qv.vault(QI_C1)).toThrow(ValidationError);
  });

  it('rejects Qi owners at deploy time', async () => {
    await expect(
      qv.factory.create({ owners: [QUAI_C1, QI_C1], threshold: 2 }),
    ).rejects.toThrow(/owner\[1\][\s\S]*Qi-ledger/);
  });

  it('rejects Qi initial modules and delegatecall targets at deploy time', async () => {
    await expect(
      qv.factory.create({ owners: [QUAI_C1], threshold: 1, initialModules: [QI_C1] }),
    ).rejects.toThrow(/initialModules\[0\]/);
    await expect(
      qv.factory.create({
        owners: [QUAI_C1],
        threshold: 1,
        initialDelegatecallTargets: [QI_C1],
      }),
    ).rejects.toThrow(/initialDelegatecallTargets\[0\]/);
  });

  it('rejects a Qi recipient for native and token transfers', async () => {
    await expect(vault.propose.transfer({ to: QI_C1, amount: 1n })).rejects.toThrow(/recipient/);
    await expect(
      vault.propose.erc20Transfer({ token: QUAI_C1, to: QI_C1, amount: 1n }),
    ).rejects.toThrow(/recipient/);
    await expect(
      vault.propose.erc721Transfer({ token: QUAI_C1, to: QI_C1, tokenId: 1n }),
    ).rejects.toThrow(/recipient/);
  });

  it('rejects a Qi owner, module and delegatecall target on proposals', async () => {
    await expect(vault.propose.addOwner(QI_C1)).rejects.toThrow(/owner/);
    await expect(vault.propose.enableModule(QI_C1)).rejects.toThrow(/module/);
    await expect(vault.propose.addDelegatecallTarget(QI_C1)).rejects.toThrow(
      /delegatecall target/,
    );
  });

  it('rejects Qi guardians and Qi recovery owners', async () => {
    await expect(
      vault.propose.setupRecovery({
        guardians: [QUAI_C1, QI_C1],
        threshold: 1,
        recoveryPeriodSeconds: 86_400,
      }),
    ).rejects.toThrow(/guardians\[1\]/);
    await expect(
      vault.recovery.initiate({ newOwners: [QI_C1], newThreshold: 1 }),
    ).rejects.toThrow(/newOwners\[0\]/);
  });

  it('still allows REMOVING a Qi address that predates the guard', async () => {
    // Removal must stay lenient, or a vault that admitted a Qi owner before this
    // check existed could never clean it up.
    await expect(vault.propose.removeOwner(QI_C1)).rejects.toThrow(/is not an owner/);
  });
});
