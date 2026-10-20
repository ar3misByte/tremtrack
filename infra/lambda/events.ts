// IoT rule target for tremor/v1/{owner}/{thing}/event. Validates the event against the protocol, stores
// it, and sends caregiver alerts (SNS email) for: a fall the user confirmed or did not answer, and a long
// tremor episode. Alerts are throttled per user and kind.
import { PutCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { validateEvent, type DeviceEvent } from '../../app/src/logic/protocol.ts';
import { ddb, K, TABLE, log } from './shared.ts';

export const LONG_EPISODE_S = 600;          // alert when one episode lasts 10 min or more
export const ALERT_GAP_S = 1800;            // at most one alert of a kind per user per 30 min

export interface Deps { db: DynamoDBDocumentClient; publish: (subject: string, message: string) => Promise<void>; now: () => number; table: string }

export function makeHandler(d: Deps) {
  return async (input: Record<string, unknown>) => {
    const owner = input.owner as string, thing = input.thing as string;
    const msg = { ...input };
    delete msg.owner; delete msg.thing;
    if (typeof owner !== 'string' || typeof thing !== 'string' || !owner || !thing) { log('warn', 'event without topic owner/thing'); return { stored: false }; }
    const v = validateEvent(msg);
    if (!v.ok) { log('warn', 'invalid event dropped', { owner, thing, errors: v.errors.slice(0, 5) }); return { stored: false, errors: v.errors }; }
    const e = v.value;
    await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: K.user(owner), sk: K.event(e.ts, thing, e.seq), thing, ...e } }));

    const alert = alertFor(e, thing);
    if (alert && await claimAlert(d, owner, alert.kind)) {
      await d.publish(alert.subject, alert.message);
      log('info', 'alert sent', { owner, kind: alert.kind });
    }
    return { stored: true, alert: alert?.kind ?? null };
  };
}

export function alertFor(e: DeviceEvent, thing: string): { kind: string; subject: string; message: string } | null {
  const when = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (e.type === 'fall' && (e.fall.outcome === 'confirmed' || e.fall.outcome === 'no-response')) {
    return {
      kind: 'fall',
      subject: 'Head Tremor Monitor: possible fall',
      message: `A possible fall was detected by the head-worn sensor "${thing}" at ${when} (impact ${e.fall.peakG} g). ` +
        (e.fall.outcome === 'confirmed' ? 'The wearer asked for help.' : 'The wearer did not answer the on-screen check within the countdown.') +
        '\n\nThis is a prototype heuristic: it can be a false alarm (for example the headset was dropped). Please check on the person directly.',
    };
  }
  if (e.type === 'episode' && e.ep.durationS >= LONG_EPISODE_S) {
    return {
      kind: 'long-episode',
      subject: 'Head Tremor Monitor: long tremor episode',
      message: `A tremor episode lasting ${Math.round(e.ep.durationS / 60)} minutes ended at ${when} (sensor "${thing}", engineering score ${e.ep.score} / 10).\n\nPrototype self-tracking device, not a medical alert.`,
    };
  }
  return null;
}

/** Throttle: one alert per kind per user per ALERT_GAP_S (a conditional put on a short-lived item). */
async function claimAlert(d: Deps, owner: string, kind: string): Promise<boolean> {
  const key = { pk: K.user(owner), sk: K.notify(kind) };
  const now = Math.floor(d.now() / 1000);
  const prev = await d.db.send(new GetCommand({ TableName: d.table, Key: key }));
  if (prev.Item && (prev.Item.sentAt as number) > now - ALERT_GAP_S) return false;
  await d.db.send(new PutCommand({ TableName: d.table, Item: { ...key, sentAt: now, ttl: now + ALERT_GAP_S } }));
  return true;
}

const sns = new SNSClient({});
export const handler = makeHandler({
  db: ddb(), table: TABLE, now: () => Date.now(),
  publish: async (Subject, Message) => { if (process.env.ALERT_TOPIC) await sns.send(new PublishCommand({ TopicArn: process.env.ALERT_TOPIC, Subject, Message })); },
});
