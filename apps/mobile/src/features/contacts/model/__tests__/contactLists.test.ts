import {
  buildContactLists,
  normalizeContact,
  uniqueNumbers,
  type NormalizedContact,
} from '../contactLists';
import type { DeviceContact } from '../../../../infra';

const dc = (
  recordId: string,
  name: string,
  phones: string[],
  thumbnailPath?: string,
): DeviceContact =>
  thumbnailPath === undefined
    ? { recordId, name, phones }
    : { recordId, name, phones, thumbnailPath };

const nc = (
  recordId: string,
  name: string,
  e164s: string[],
  thumbnailPath?: string,
): NormalizedContact =>
  thumbnailPath === undefined
    ? { recordId, name, e164s }
    : { recordId, name, e164s, thumbnailPath };

describe('normalizeContact', () => {
  it('normalizes local-format numbers using the region', () => {
    expect(
      normalizeContact(dc('1', 'Mom', ['09812345678']), 'IN')?.e164s,
    ).toEqual(['+919812345678']);
  });

  it('normalizes formatting noise to the same E.164', () => {
    const a = normalizeContact(dc('1', 'A', ['+91 98123-45678']), 'IN');
    const b = normalizeContact(dc('2', 'B', ['+919812345678']), 'IN');
    expect(a?.e164s).toEqual(b?.e164s);
  });

  it('de-duplicates the same number saved twice on one contact', () => {
    const out = normalizeContact(
      dc('1', 'Mom', ['09812345678', '+91 98123 45678']),
      'IN',
    );
    expect(out?.e164s).toEqual(['+919812345678']);
  });

  it('drops a contact whose numbers cannot be parsed', () => {
    expect(
      normalizeContact(dc('1', 'Nope', ['not-a-number', '123']), 'IN'),
    ).toBeUndefined();
  });

  it('keeps the parseable numbers when only some are junk', () => {
    const out = normalizeContact(
      dc('1', 'Mixed', ['abc', '09812345678']),
      'IN',
    );
    expect(out?.e164s).toEqual(['+919812345678']);
  });

  it('carries the photo through only when there is one', () => {
    expect(
      normalizeContact(dc('1', 'A', ['+919812345678']), 'IN'),
    ).not.toHaveProperty('thumbnailPath');
    expect(
      normalizeContact(dc('1', 'A', ['+919812345678'], 'file:///p.jpg'), 'IN')
        ?.thumbnailPath,
    ).toBe('file:///p.jpg');
  });
});

describe('uniqueNumbers', () => {
  it('is stable in book order and de-duplicated', () => {
    const book = [
      nc('1', 'A', ['+911', '+912']),
      nc('2', 'B', ['+912', '+913']),
    ];
    expect(uniqueNumbers(book)).toEqual(['+911', '+912', '+913']);
  });
  it('excludes the caller own number', () => {
    const book = [nc('1', 'A', ['+911', '+912'])];
    expect(uniqueNumbers(book, '+911')).toEqual(['+912']);
  });
});

describe('buildContactLists', () => {
  const book = [
    nc('1', 'Zara', ['+911']),
    nc('2', 'Amit', ['+912']),
    nc('3', 'Bhavna', ['+913']),
  ];

  it('splits matched contacts into VelChat and the rest into invite', () => {
    const { onVelchat, invitable } = buildContactLists(
      book,
      new Map([['+911', 'accZ']]),
    );
    expect(onVelchat.map(c => c.name)).toEqual(['Zara']);
    expect(invitable.map(c => c.name)).toEqual(['Amit', 'Bhavna']);
  });

  it('sorts both sections alphabetically', () => {
    const { onVelchat, invitable } = buildContactLists(
      book,
      new Map([
        ['+911', 'accZ'],
        ['+912', 'accA'],
      ]),
    );
    expect(onVelchat.map(c => c.name)).toEqual(['Amit', 'Zara']);
    expect(invitable.map(c => c.name)).toEqual(['Bhavna']);
  });

  it('collapses the same person saved twice under one account row', () => {
    const dup = [nc('1', 'Amit', ['+911']), nc('2', 'Amit Office', ['+912'])];
    const { onVelchat } = buildContactLists(
      dup,
      new Map([
        ['+911', 'accA'],
        ['+912', 'accA'],
      ]),
    );
    expect(onVelchat).toHaveLength(1);
    expect(onVelchat[0]?.name).toBe('Amit');
  });

  it('collapses the same NUMBER saved under two names into one invite row', () => {
    const dup = [nc('1', 'Plumber', ['+911']), nc('2', 'Ramesh', ['+911'])];
    const { invitable } = buildContactLists(dup, new Map());
    expect(invitable).toHaveLength(1);
  });

  it('matches on any of a contact numbers, keeping the one that matched', () => {
    const multi = [nc('1', 'Amit', ['+911', '+912'])];
    const { onVelchat } = buildContactLists(multi, new Map([['+912', 'accA']]));
    expect(onVelchat[0]?.phoneE164).toBe('+912');
  });

  it('never lists the signed-in user', () => {
    const { onVelchat, invitable } = buildContactLists(
      [nc('1', 'Me', ['+911']), nc('2', 'MyOtherSim', ['+915'])],
      new Map([['+911', 'me']]),
      { myAccountId: 'me', myPhoneE164: '+915' },
    );
    expect(onVelchat).toEqual([]);
    expect(invitable).toEqual([]);
  });

  it('puts everything in invite when nothing is known yet', () => {
    const { onVelchat, invitable } = buildContactLists(book, new Map());
    expect(onVelchat).toEqual([]);
    expect(invitable).toHaveLength(3);
  });

  it('carries the photo onto both row kinds', () => {
    const withPhoto = [
      nc('1', 'Amit', ['+911'], 'file:///a.jpg'),
      nc('2', 'Bhavna', ['+912'], 'file:///b.jpg'),
    ];
    const { onVelchat, invitable } = buildContactLists(
      withPhoto,
      new Map([['+911', 'accA']]),
    );
    expect(onVelchat[0]?.thumbnailPath).toBe('file:///a.jpg');
    expect(invitable[0]?.thumbnailPath).toBe('file:///b.jpg');
  });

  it('keys VelChat rows by account and invite rows by record', () => {
    // The keys drive FlashList identity; a collision here recycles the wrong row.
    const { onVelchat, invitable } = buildContactLists(
      book,
      new Map([['+911', 'accZ']]),
    );
    expect(onVelchat[0]?.key).toBe('accZ');
    expect(invitable.map(c => c.key)).toEqual(['2', '3']);
  });
});
