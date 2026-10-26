'use strict';
/*
 * Storage: Redis over the Upstash / Vercel KV REST API when configured,
 * otherwise an in-memory store (fine for local runs; resets on every cold start).
 *
 * Env vars are matched by SUFFIX, because Vercel prefixes injected store
 * variables with the store name (e.g. ORBIT_KV_REST_API_URL).
 */

function envBySuffix(suffixes) {
  for (const s of suffixes) {
    if (process.env[s]) return process.env[s];
    const k = Object.keys(process.env).find((name) => name.endsWith('_' + s));
    if (k && process.env[k]) return process.env[k];
  }
  return '';
}

const REST_URL = envBySuffix(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const REST_TOKEN = envBySuffix(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);

function restStore() {
  async function cmd(args) {
    const r = await fetch(REST_URL.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map((a) => (typeof a === 'string' ? a : String(a))))
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new Error('Storage returned ' + r.status); }
    if (body.error) throw new Error('Storage: ' + body.error);
    return body.result;
  }
  return {
    kind: 'redis',
    async get(k) { return cmd(['GET', k]); },
    async set(k, v) { return cmd(['SET', k, v]); },
    async del(k) { return cmd(['DEL', k]); },
    async hset(k, f, v) { return cmd(['HSET', k, f, v]); },
    async hget(k, f) { return cmd(['HGET', k, f]); },
    async hdel(k, f) { return cmd(['HDEL', k, f]); },
    async hgetall(k) {
      const arr = (await cmd(['HGETALL', k])) || [];
      if (!Array.isArray(arr)) return arr || {};
      const o = {};
      for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
      return o;
    },
    async push(k, v, max, ttlSeconds) {
      await cmd(['RPUSH', k, v]);
      if (max) await cmd(['LTRIM', k, -max, -1]);
      if (ttlSeconds) await cmd(['EXPIRE', k, ttlSeconds]);
    },
    async list(k) { return (await cmd(['LRANGE', k, 0, -1])) || []; }
  };
}

function memoryStore() {
  const kv = new Map();
  const hashes = new Map();
  const lists = new Map();
  return {
    kind: 'memory',
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, String(v)); return 'OK'; },
    async del(k) { kv.delete(k); hashes.delete(k); lists.delete(k); return 1; },
    async hset(k, f, v) { if (!hashes.has(k)) hashes.set(k, new Map()); hashes.get(k).set(f, String(v)); return 1; },
    async hget(k, f) { const h = hashes.get(k); return h && h.has(f) ? h.get(f) : null; },
    async hdel(k, f) { const h = hashes.get(k); if (h) h.delete(f); return 1; },
    async hgetall(k) { const h = hashes.get(k); const o = {}; if (h) for (const [a, b] of h) o[a] = b; return o; },
    async push(k, v, max) {
      if (!lists.has(k)) lists.set(k, []);
      const l = lists.get(k); l.push(String(v));
      if (max && l.length > max) l.splice(0, l.length - max);
    },
    async list(k) { return (lists.get(k) || []).slice(); }
  };
}

const store = REST_URL && REST_TOKEN ? restStore() : memoryStore();
store.configured = store.kind === 'redis';
module.exports = store;
module.exports.envBySuffix = envBySuffix;
