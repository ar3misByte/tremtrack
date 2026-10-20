// In-memory stand-in for the DynamoDB document client, covering exactly the commands and expression forms the
// Lambdas use. Queries are paginated (page size 50) so the handlers' pagination loops are exercised.
type Item = Record<string, unknown>;

export class FakeDdb {
  items = new Map<string, Item>();
  calls: string[] = [];
  private k = (pk: unknown, sk: unknown) => `${pk}\u0000${sk}`;

  async send(cmd: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
    const n = cmd.constructor.name, i = cmd.input;
    this.calls.push(n);
    switch (n) {
      case 'PutCommand': this.items.set(this.k(i.Item.pk, i.Item.sk), structuredClone(i.Item)); return {};
      case 'GetCommand': { const it = this.items.get(this.k(i.Key.pk, i.Key.sk)); return { Item: it ? structuredClone(it) : undefined }; }
      case 'DeleteCommand': this.items.delete(this.k(i.Key.pk, i.Key.sk)); return {};
      case 'UpdateCommand': return this.update(i);
      case 'QueryCommand': return this.query(i);
      case 'BatchWriteCommand': {
        for (const reqs of Object.values(i.RequestItems) as any[]) for (const r of reqs) {
          if (r.PutRequest) this.items.set(this.k(r.PutRequest.Item.pk, r.PutRequest.Item.sk), structuredClone(r.PutRequest.Item));
          if (r.DeleteRequest) this.items.delete(this.k(r.DeleteRequest.Key.pk, r.DeleteRequest.Key.sk));
        }
        return { UnprocessedItems: {} };
      }
      default: throw new Error('FakeDdb: unsupported ' + n);
    }
  }

  private update(i: Record<string, any>) {
    const key = this.k(i.Key.pk, i.Key.sk);
    const item: Item = this.items.get(key) ?? { ...i.Key };
    const expr: string = i.UpdateExpression;
    const m = /^SET (.+)$/.exec(expr);
    if (!m) throw new Error('FakeDdb: only SET supported: ' + expr);
    for (const part of m[1].split(/,\s*/)) {
      const [lhs, rhs] = part.split(/\s*=\s*/);
      const name = lhs.startsWith('#') ? i.ExpressionAttributeNames[lhs] : lhs;
      item[name] = structuredClone(i.ExpressionAttributeValues[rhs]);
    }
    this.items.set(key, item);
    return {};
  }

  private query(i: Record<string, any>) {
    const v = i.ExpressionAttributeValues;
    const kc: string = i.KeyConditionExpression;
    let pred: (it: Item) => boolean;
    let mm: RegExpExecArray | null;
    if ((mm = /^pk = (:\w+) AND sk BETWEEN (:\w+) AND (:\w+)$/.exec(kc))) pred = (it) => it.pk === v[mm![1]] && (it.sk as string) >= v[mm![2]] && (it.sk as string) <= v[mm![3]];
    else if ((mm = /^pk = (:\w+) AND begins_with\(sk, (:\w+)\)$/.exec(kc))) pred = (it) => it.pk === v[mm![1]] && (it.sk as string).startsWith(v[mm![2]]);
    else if ((mm = /^pk = (:\w+)$/.exec(kc))) pred = (it) => it.pk === v[mm![1]];
    else throw new Error('FakeDdb: unsupported key condition ' + kc);
    const all = [...this.items.values()].filter(pred).sort((a, b) => ((a.sk as string) < (b.sk as string) ? -1 : 1));
    const start = i.ExclusiveStartKey ? all.findIndex((x) => x.sk === i.ExclusiveStartKey.sk) + 1 : 0;
    const page = all.slice(start, start + 50);
    return { Items: structuredClone(page), LastEvaluatedKey: start + 50 < all.length ? { pk: page.at(-1)!.pk, sk: page.at(-1)!.sk } : undefined };
  }
}

/**
 * TypeScript mirror of the IoT rule SQL in lib/stack.ts (kept side by side; stack.test.ts checks the SQL text
 * contains the same key expressions). Returns the item the DynamoDBv2 action would put, or null if WHERE fails.
 */
export const rules = {
  telemetry(topic: string, msg: Record<string, any>, nowMs: number) {
    const [, , owner, thing] = topic.split('/');
    if (!(msg.v === 1 && typeof msg.seq === 'number' && typeof msg.ts === 'number' && msg.ts > 1704067200000 && msg.ts < 4102444800000 && typeof msg.per === 'number' && (msg.tr === 0 || msg.tr === 1))) return null;
    return { ...msg, pk: `U#${owner}`, sk: `T#${thing}#${String(msg.ts)}`, thing, ttl: Math.floor(nowMs / 1000) + 14 * 86400 };
  },
  status(topic: string, msg: Record<string, any>, nowMs: number) {
    const [, , owner, thing] = topic.split('/');
    if (!(msg.v === 1 && typeof msg.online === 'boolean')) return null;
    return [
      { ...msg, pk: `U#${owner}`, sk: `D#${thing}`, thing, lastSeen: nowMs },
      { pk: 'DEVICES', sk: thing, owner, lastSeen: nowMs, tzMin: msg.tzMin, online: msg.online },
    ];
  },
  event(topic: string, msg: Record<string, any>) {
    const [, , owner, thing] = topic.split('/');
    return msg.v === 1 ? { ...msg, owner, thing } : null;
  },
};
