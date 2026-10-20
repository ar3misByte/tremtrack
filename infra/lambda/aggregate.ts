// Hourly (EventBridge). For each device seen recently, summarises each COMPLETED local hour of telemetry
// into the day record (attribute h00..h23, overwritten, so re-runs and retries are idempotent), then
// recomputes the day's totals and its severity score from the day's episode events with the same formula
// as the app (app/src/logic/severity.ts). A cursor per device (`aggHour`) skips hours already done.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { dailyScore } from '../../app/src/logic/severity.ts';
import type { Telemetry, DeviceEvent } from '../../app/src/logic/protocol.ts';
import { DEFAULT_TZ_MIN, K, TABLE, dayStartUtc, ddb, localDay, log } from './shared.ts';

export const ACTIVE_WITHIN_MS = 26 * 3_600_000;
export const LOW_SPO2 = 92;
const H = 3_600_000;

export interface Deps { db: DynamoDBDocumentClient; now: () => number; table: string; publish?: (subject: string, message: string) => Promise<void> }

export interface HourAcc { monitoredS: number; tremorS: number; walkingS: number; stillS: number; restlessS: number; hrSum: number; hrN: number; restHrSum: number; restHrN: number; spSum: number; spN: number; restSpSum: number; restSpN: number; n: number }
const FIELDS: (keyof HourAcc)[] = ['monitoredS', 'tremorS', 'walkingS', 'stillS', 'restlessS', 'hrSum', 'hrN', 'restHrSum', 'restHrN', 'spSum', 'spN', 'restSpSum', 'restSpN', 'n'];
const zero = (): HourAcc => Object.fromEntries(FIELDS.map((f) => [f, 0])) as unknown as HourAcc;

export function summarizeHour(tel: Telemetry[]): HourAcc {
  const a = zero();
  for (const t of tel) {
    const per = t.per;
    a.n++; a.monitoredS += per;
    if (t.tr) a.tremorS += per;
    if (t.wk) a.walkingS += per;
    if (t.st === 'still') a.stillS += per;
    if (t.st === 'restless') a.restlessS += per;
    if (t.hr !== null) { a.hrSum += t.hr; a.hrN++; if (t.st === 'still') { a.restHrSum += t.hr; a.restHrN++; } }
    if (t.sp !== null) { a.spSum += t.sp; a.spN++; if (t.st === 'still') { a.restSpSum += t.sp; a.restSpN++; } }
  }
  return a;
}

async function queryAll(d: Deps, input: ConstructorParameters<typeof QueryCommand>[0]) {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await d.db.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
    items.push(...((r.Items ?? []) as Record<string, unknown>[]));
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return items;
}

export function makeHandler(d: Deps) {
  /** includeCurrentHour: also summarise the hour in progress (used by the cloud e2e test). It is re-done by the next normal run, because the cursor only moves past complete hours. */
  return async (event?: { includeCurrentHour?: boolean }) => {
    const now = d.now();
    const devices = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': K.devices } });
    let hours = 0;
    for (const dev of devices) {
      if ((dev.lastSeen as number) < now - ACTIVE_WITHIN_MS) continue;
      const owner = dev.owner as string, thing = dev.sk as string;
      const tzMin = typeof dev.tzMin === 'number' ? dev.tzMin : DEFAULT_TZ_MIN;
      const lastFull = Math.floor((now - 60_000) / H) * H;              // hours ending before this are complete
      let h = typeof dev.aggHour === 'number' ? dev.aggHour : Math.floor((now - ACTIVE_WITHIN_MS) / H) * H;
      const days = new Set<string>();
      const until = event?.includeCurrentHour ? now : lastFull;
      for (; h < until; h += H) {
        const tel = await queryAll(d, {
          TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':p': K.user(owner), ':a': K.tel(thing, h), ':b': K.tel(thing, h + H - 1) },
        }) as unknown as Telemetry[];
        if (!tel.length) continue;
        const day = localDay(h, tzMin);
        const hk = 'h' + String(new Date(h + tzMin * 60_000).getUTCHours()).padStart(2, '0');
        await d.db.send(new UpdateCommand({
          TableName: d.table, Key: { pk: K.user(owner), sk: K.day(day) },
          UpdateExpression: 'SET #h = :acc, tzMin = :tz, #d = :day',
          ExpressionAttributeNames: { '#h': `${hk}_${thing}`, '#d': 'day' },
          ExpressionAttributeValues: { ':acc': summarizeHour(tel), ':tz': tzMin, ':day': day },
        }));
        days.add(day);
        hours++;
      }
      for (const day of days) await rescore(d, owner, day, tzMin);
      await d.db.send(new UpdateCommand({ TableName: d.table, Key: { pk: K.devices, sk: thing }, UpdateExpression: 'SET aggHour = :h', ExpressionAttributeValues: { ':h': lastFull } }));
    }
    log('info', 'aggregate done', { devices: devices.length, hours });
    return { hours };
  };
}

/** Day totals from the hour buckets (all devices) + score from the day's episode events. */
export async function rescore(d: Deps, owner: string, day: string, tzMin: number) {
  const cur = await d.db.send(new GetCommand({ TableName: d.table, Key: { pk: K.user(owner), sk: K.day(day) } }));
  const item = cur.Item ?? {};
  const tot = zero();
  for (const [k, v] of Object.entries(item)) if (/^h\d\d_/.test(k)) for (const f of FIELDS) tot[f] += (v as HourAcc)[f] ?? 0;
  const a = dayStartUtc(day, tzMin), b = a + 86_400_000 - 1;
  const evs = await queryAll(d, {
    TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':p': K.user(owner), ':a': `E#${String(a).padStart(13, '0')}`, ':b': `E#${String(b).padStart(13, '0')}~` },
  }) as unknown as DeviceEvent[];
  const eps = evs.filter((e) => e.type === 'episode').map((e) => (e as DeviceEvent & { type: 'episode' }).ep);
  const falls = evs.filter((e) => e.type === 'fall' && (e as DeviceEvent & { type: 'fall' }).fall.outcome !== 'pending').length;
  const ds = dailyScore({ episodes: eps.map((e) => ({ ampDps: e.ampDps, freqHz: e.freqHz, durationS: e.durationS })), monitoredS: tot.monitoredS });
  const restHr = tot.restHrN >= 30 ? tot.restHrSum / tot.restHrN : null;
  const restSp = tot.restSpN >= 30 ? tot.restSpSum / tot.restSpN : null;
  await d.db.send(new UpdateCommand({
    TableName: d.table, Key: { pk: K.user(owner), sk: K.day(day) },
    UpdateExpression: 'SET monitoredS = :m, tremorS = :t, walkingS = :w, stillS = :s, restlessS = :r, score = :sc, episodes = :e, combinedEpisodes = :c, falls = :f, maxEpisodeScore = :mx, restingBpm = :rh, restingSpo2 = :rs, meanBpm = :hb',
    ExpressionAttributeValues: {
      ':m': tot.monitoredS, ':t': tot.tremorS, ':w': tot.walkingS, ':s': tot.stillS, ':r': tot.restlessS, ':sc': ds.score, ':e': eps.length,
      ':c': eps.filter((e) => e.axes.length > 1).length, ':f': falls, ':mx': eps.length ? Math.max(...eps.map((e) => e.score)) : null,
      ':rh': restHr, ':rs': restSp, ':hb': tot.hrN ? tot.hrSum / tot.hrN : null,
    },
  }));
  if (restSp !== null && restSp < LOW_SPO2 && d.publish) {
    const key = { pk: K.user(owner), sk: K.notify('low-spo2#' + day) };
    const prev = await d.db.send(new GetCommand({ TableName: d.table, Key: key }));
    if (!prev.Item) {
      await d.db.send(new PutCommand({ TableName: d.table, Item: { ...key, sentAt: Math.floor(d.now() / 1000), ttl: Math.floor(d.now() / 1000) + 2 * 86_400 } }));
      await d.publish('Head Tremor Monitor: low resting SpO2 estimate', `The resting SpO2 estimate on ${day} averaged ${restSp.toFixed(0)} %. This hobby sensor is not calibrated and is easily affected by finger position; if readings stay low, it may be worth checking with a doctor or a calibrated oximeter.`);
    }
  }
}

const sns = new SNSClient({});
export const handler = makeHandler({
  db: ddb(), table: TABLE, now: () => Date.now(),
  publish: async (Subject, Message) => { if (process.env.ALERT_TOPIC) await sns.send(new PublishCommand({ TopicArn: process.env.ALERT_TOPIC, Subject, Message })); },
});
