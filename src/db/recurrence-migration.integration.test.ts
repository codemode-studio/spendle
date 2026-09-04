import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), `drizzle/${name}`), 'utf8')
}

describe('upgrade legado de recorrências', () => {
  let sqlite: Database.Database | undefined

  afterEach(() => sqlite?.close())

  it('preserva vínculos, repara datas 29–31 e altera apenas grupos PJ/PF alvo', () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(`
      CREATE TABLE ownership_scopes (id text PRIMARY KEY NOT NULL, type text NOT NULL);
      CREATE TABLE accounts (id text PRIMARY KEY NOT NULL, ownership_scope_id text NOT NULL);
      CREATE TABLE credit_cards (id text PRIMARY KEY NOT NULL, ownership_scope_id text NOT NULL);
      CREATE TABLE categories (id text PRIMARY KEY NOT NULL, name text NOT NULL, bucket text NOT NULL);
      CREATE TABLE monthly_budgets (id text PRIMARY KEY NOT NULL);
      CREATE TABLE transactions (
        id text PRIMARY KEY NOT NULL,
        account_id text,
        credit_card_id text,
        category_id text
      );
      CREATE TABLE reconciliation_groups (
        id text PRIMARY KEY NOT NULL,
        type text NOT NULL,
        status text NOT NULL,
        confidence integer NOT NULL,
        reason text
      );
      CREATE TABLE reconciliation_links (
        id text PRIMARY KEY NOT NULL,
        group_id text NOT NULL,
        transaction_id text NOT NULL,
        previous_category_id text
      );
      CREATE TABLE recurrences (
        id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        account_id text,
        credit_card_id text,
        category_id text,
        amount_cents integer NOT NULL,
        currency text DEFAULT 'BRL' NOT NULL,
        frequency text NOT NULL,
        next_date text NOT NULL,
        active integer DEFAULT true NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      );

      INSERT INTO ownership_scopes VALUES ('company', 'company_br'), ('family', 'person');
      INSERT INTO accounts VALUES
        ('company-account', 'company'),
        ('family-account-a', 'family'),
        ('family-account-b', 'family');
      INSERT INTO categories (id, name, bucket) VALUES
        ('housing', 'Moradia', 'essential'),
        ('transfer', 'Transferência', 'excluded');
      INSERT INTO transactions VALUES
        ('recurrence-payment', 'family-account-a', null, 'housing'),
        ('target-company', 'company-account', null, 'transfer'),
        ('target-family', 'family-account-a', null, 'transfer'),
        ('control-a', 'family-account-a', null, 'transfer'),
        ('control-b', 'family-account-b', null, 'transfer');
      INSERT INTO reconciliation_groups VALUES
        ('target-group', 'transfer', 'confirmed', 99, 'Contas vinculadas por uma confirmação manual anterior.'),
        ('control-group', 'transfer', 'confirmed', 99, 'Contas vinculadas por uma confirmação manual anterior.');
      INSERT INTO reconciliation_links VALUES
        ('target-link-company', 'target-group', 'target-company', 'housing'),
        ('target-link-family', 'target-group', 'target-family', 'housing'),
        ('control-link-a', 'control-group', 'control-a', 'housing'),
        ('control-link-b', 'control-group', 'control-b', 'housing');
      INSERT INTO recurrences (
        id, name, category_id, amount_cents, frequency, next_date
      ) VALUES
        ('recurrence-29', 'Anual dia 29', 'housing', 100000, 'yearly', '2024-02-29'),
        ('recurrence-30', 'Mensal dia 30', 'housing', 100000, 'monthly', '2026-03-30'),
        ('recurrence-31', 'Mensal dia 31', 'housing', 100000, 'monthly', '2026-03-31');
    `)

    sqlite.exec(migration('0019_greedy_the_renegades.sql'))
    sqlite.exec(`
      INSERT INTO recurrence_occurrences (
        id, recurrence_id, expected_date, expected_amount_cents,
        currency, direction, category_id, status
      ) VALUES (
        'occurrence-1', 'recurrence-31', '2026-02-28', 100000,
        'BRL', 'expense', 'housing', 'matched'
      );
      INSERT INTO recurrence_matches (
        id, occurrence_id, transaction_id, status, score, reason
      ) VALUES (
        'match-1', 'occurrence-1', 'recurrence-payment', 'confirmed', 95, 'teste'
      );
      INSERT INTO recurrence_occurrences (
        id, recurrence_id, expected_date, expected_amount_cents,
        currency, direction, category_id, status
      ) VALUES (
        'spurious-occurrence', 'recurrence-31', '2026-03-03', 100000,
        'BRL', 'expense', 'housing', 'expected'
      );
      INSERT INTO recurrence_matches (
        id, occurrence_id, transaction_id, status, score, reason
      ) VALUES (
        'spurious-match', 'spurious-occurrence', 'target-family', 'suggested', 80, 'legado'
      );
    `)
    sqlite.exec(migration('0020_loose_adam_destine.sql'))

    // Estado persistido pelas versões antigas antes da correção do SQL.
    sqlite.exec(`
      UPDATE recurrences SET starts_on = '2023-03-01' WHERE id = 'recurrence-29';
      UPDATE recurrences SET starts_on = '2026-03-02' WHERE id = 'recurrence-30';
      UPDATE recurrences SET starts_on = '2026-03-03' WHERE id = 'recurrence-31';
    `)
    sqlite.exec(migration('0021_gigantic_quentin_quire.sql'))
    sqlite.exec(migration('0022_backfill_recurrence_schedule_anchor.sql'))
    sqlite.exec(`
      INSERT INTO recurrences (
        id, name, category_id, amount_cents, frequency,
        starts_on, schedule_anchor, next_date
      ) VALUES (
        'new-recurrence', 'Recorrência nova', 'housing', 5000, 'monthly',
        '2026-04-30', '2026-04-30', '2026-04-30'
      );
      INSERT INTO recurrence_occurrences (
        id, recurrence_id, expected_date, expected_amount_cents,
        currency, direction, category_id, status
      ) VALUES (
        'new-occurrence', 'new-recurrence', '2026-04-30', 5000,
        'BRL', 'expense', 'housing', 'expected'
      );
    `)
    sqlite.exec(migration('0023_repair_legacy_recurrence_dates.sql'))
    sqlite.exec(migration('0024_cancel_invalid_legacy_occurrences.sql'))
    sqlite.exec(migration('0024_cancel_invalid_legacy_occurrences.sql'))

    expect(
      sqlite
        .prepare(
          'SELECT id, starts_on AS startsOn, schedule_anchor AS scheduleAnchor FROM recurrences ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'new-recurrence',
        startsOn: '2026-04-30',
        scheduleAnchor: '2026-04-30',
      },
      {
        id: 'recurrence-29',
        startsOn: '2023-02-28',
        scheduleAnchor: '2024-02-29',
      },
      {
        id: 'recurrence-30',
        startsOn: '2026-02-28',
        scheduleAnchor: '2026-03-30',
      },
      {
        id: 'recurrence-31',
        startsOn: '2026-02-28',
        scheduleAnchor: '2026-03-31',
      },
    ])
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_matches WHERE id = ?')
        .pluck()
        .get('match-1'),
    ).toBe('confirmed')
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_occurrences WHERE id = ?')
        .pluck()
        .get('spurious-occurrence'),
    ).toBe('cancelled')
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_matches WHERE id = ?')
        .pluck()
        .get('spurious-match'),
    ).toBe('rejected')
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_occurrences WHERE id = ?')
        .pluck()
        .get('new-occurrence'),
    ).toBe('expected')
    expect(
      sqlite
        .prepare('SELECT type, status FROM reconciliation_groups WHERE id = ?')
        .get('target-group'),
    ).toEqual({ type: 'profit_distribution', status: 'suggested' })
    expect(
      sqlite
        .prepare('SELECT type, status FROM reconciliation_groups WHERE id = ?')
        .get('control-group'),
    ).toEqual({ type: 'transfer', status: 'confirmed' })
    expect(
      sqlite
        .prepare('SELECT category_id FROM transactions WHERE id = ?')
        .pluck()
        .get('target-family'),
    ).toBe('housing')
    expect(
      sqlite
        .prepare('SELECT category_id FROM transactions WHERE id = ?')
        .pluck()
        .get('control-a'),
    ).toBe('transfer')
    sqlite.exec(`
      INSERT INTO recurrences (
        id, name, category_id, amount_cents, frequency,
        starts_on, schedule_anchor, next_date
      ) VALUES
        ('academia', 'Academia', 'housing', 50000, 'monthly', '2026-09-15', '2026-09-15', '2026-09-15'),
        ('psiquiatra', 'Psiquiatra', 'housing', 130000, 'monthly', '2026-09-10', '2026-09-10', '2026-09-10'),
        ('terapeuta', 'Terapeuta', 'housing', 300000, 'monthly', '2026-09-10', '2026-09-10', '2026-09-10');
    `)
    sqlite.exec(migration('0025_lush_dracula.sql'))

    expect(
      sqlite
        .prepare(
          `SELECT r.name, r.amount_cents AS amountCents,
             g.name AS groupName, r.participant_label AS participantLabel
           FROM recurrences r
           JOIN recurrence_groups g ON g.id = r.group_id
           WHERE r.id IN ('academia', 'psiquiatra', 'terapeuta')
           ORDER BY r.name`,
        )
        .all(),
    ).toEqual([
      {
        name: 'Academia',
        amountCents: 50_000,
        groupName: 'Academia',
        participantLabel: 'Família',
      },
      {
        name: 'Psiquiatra',
        amountCents: 130_000,
        groupName: 'Psiquiatra',
        participantLabel: 'Família',
      },
      {
        name: 'Terapeuta',
        amountCents: 300_000,
        groupName: 'Terapeuta',
        participantLabel: 'Família',
      },
    ])
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_matches WHERE id = ?')
        .pluck()
        .get('match-1'),
    ).toBe('confirmed')
    sqlite.exec(migration('0026_split_family_recurrence_groups.sql'))
    expect(
      sqlite
        .prepare(
          `SELECT g.name AS groupName, r.participant_label AS participantLabel,
             r.amount_cents AS amountCents
           FROM recurrences r
           JOIN recurrence_groups g ON g.id = r.group_id
           WHERE g.normalized_name IN ('academia', 'psiquiatra', 'terapeuta')
           ORDER BY g.name, r.participant_label`,
        )
        .all(),
    ).toEqual([
      {
        groupName: 'Academia',
        participantLabel: 'Dayane',
        amountCents: 25_000,
      },
      {
        groupName: 'Academia',
        participantLabel: 'Donald',
        amountCents: 25_000,
      },
      {
        groupName: 'Psiquiatra',
        participantLabel: 'Dayane',
        amountCents: 70_000,
      },
      {
        groupName: 'Psiquiatra',
        participantLabel: 'Donald',
        amountCents: 60_000,
      },
      {
        groupName: 'Terapeuta',
        participantLabel: 'Dayane',
        amountCents: 150_000,
      },
      {
        groupName: 'Terapeuta',
        participantLabel: 'Donald',
        amountCents: 150_000,
      },
    ])
    expect(
      sqlite
        .prepare('SELECT status FROM recurrence_matches WHERE id = ?')
        .pluck()
        .get('match-1'),
    ).toBe('confirmed')
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })
})
