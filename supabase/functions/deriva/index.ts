// Deriva's backend: one POST endpoint, `{ op, ... }` in, `{ view }` or `{ error }` out.
// Rooms live in public.deriva_rooms as one JSON state each; writes are optimistic on `version`.
// Players authenticate with the room code, their id and the token handed out at join.

import { createClient } from 'npm:@supabase/supabase-js@2'

import {
  act,
  type Action,
  ACTIONS,
  addPlayer,
  advance,
  beat,
  beatChanges,
  changeRole,
  cleanNickname,
  createState,
  MINUTE,
  type Role,
  ROLES,
  type Signal,
  signal,
  SIGNALS,
  type State,
  toView,
} from './engine.ts'

const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false },
})

const TABLE = 'deriva_rooms'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_BODY_BYTES = 2048
const MAX_ATTEMPTS = 5
/** A read that ran the ship this far forward stores the result, so later reads start from there. */
const CHECKPOINT_MS = 30 * MINUTE
const BAD_CREDENTIALS = 'Credenziali non valide per questa stanza.'
/** Matches the nightly deriva_delete_abandoned_rooms job (migration 20261007020000). */
const ABANDONED_DAYS = 30
/** Keys the hash of the caller's IP, so the stored hashes cannot be reversed by trying every IP. */
const IP_KEY = Deno.env.get('DERIVA_IP_SALT') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const CREATION_LIMITS: Record<string, string> = {
  hour: "Hai già creato 3 navi nell'ultima ora: riprova più tardi, o sali su quella del team.",
  day: 'Hai raggiunto il limite di 10 navi al giorno: riprova domani.',
  overall: "Troppe navi create nell'ultima ora: riprova tra poco.",
}
const JOIN_LIMIT = "Troppi tentativi di ingresso da questa rete nell'ultima ora (massimo 20): riprova più tardi."

const HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, apikey',
  'access-control-allow-methods': 'POST, OPTIONS',
}

type Outcome = { state: State; error?: string; isChanged: boolean }

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

function newCode(): string {
  const picks = crypto.getRandomValues(new Uint8Array(4))
  return `DRV-${Array.from(picks, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/**
 * The caller's IP as Supabase's gateway sets it. Not x-forwarded-for, which a caller can write:
 * the gateway drops a client's own, but the limit should not depend on that.
 */
function callerIp(req: Request): string {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip')
  if (!ip) console.warn('deriva: no caller IP header; such callers share one rate limit')

  return ip || 'unknown'
}

async function ipHash(req: Request): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(callerIp(req)))

  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')
}

/** Claims one room creation for this caller: null when allowed, else the limit's message. */
async function claimCreation(req: Request): Promise<string | null> {
  const { data, error } = await db.rpc('deriva_claim_room_creation', { p_ip_hash: await ipHash(req) })
  if (error) throw error

  return data === 'ok' ? null : (CREATION_LIMITS[String(data)] ?? CREATION_LIMITS.overall ?? null)
}

/** Claims one join attempt for this caller, a wrong code included: null when allowed, else why not. */
async function claimJoin(req: Request): Promise<string | null> {
  const { data, error } = await db.rpc('deriva_claim_join_attempt', { p_ip_hash: await ipHash(req) })
  if (error) throw error

  return data === 'ok' ? null : JOIN_LIMIT
}

async function load(code: string): Promise<{ state: State; version: number } | null> {
  const { data, error } = await db.from(TABLE).select('state, version').eq('code', code).maybeSingle()
  if (error) throw error

  return data as { state: State; version: number } | null
}

async function save(code: string, version: number, state: State): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE)
    .update({ state, version: version + 1, updated_at: new Date().toISOString() })
    .eq('code', code)
    .eq('version', version)
    .select('version')
  if (error) throw error

  return (data?.length ?? 0) > 0
}

/** Applies `change` to the room and stores it when it changed, retrying when another write won. */
async function run(
  code: string,
  change: (state: State, now: number) => Outcome,
): Promise<(Outcome & { now: number }) | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await load(code)
    if (!row) return null

    const now = Date.now()
    const tickBefore = row.state.tickAt
    const outcome = change(row.state, now)
    const isStale = outcome.state.tickAt - tickBefore >= CHECKPOINT_MS
    if (outcome.error || (!outcome.isChanged && !isStale)) return { ...outcome, now }
    if (await save(code, row.version, outcome.state)) return { ...outcome, now }
  }

  throw new Error('Too many concurrent writes')
}

async function create(req: Request, body: Record<string, unknown>): Promise<Response> {
  const nickname = cleanNickname(text(body.nickname, 64) ?? '')
  if (!nickname) return reply({ error: 'Scegli un nome di almeno 2 caratteri.' }, 400)
  const limit = await claimCreation(req)
  if (limit) return reply({ error: limit }, 429)

  const playerId = crypto.randomUUID()
  const token = randomHex(24)
  const tokenHash = await sha256(token)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = Date.now()
    const code = newCode()
    const state = createState(code, crypto.getRandomValues(new Uint32Array(1))[0] ?? 1, now)
    addPlayer(state, { id: playerId, tokenHash, nickname, role: 'ingegnere' }, now)
    const { error } = await db.from(TABLE).insert({ code, state, version: 0 })
    if (!error) return reply({ code, playerId, token, view: toView(state, playerId, now) })
    if (error.code !== '23505') throw error
  }

  throw new Error('No free room code')
}

async function join(req: Request, body: Record<string, unknown>): Promise<Response> {
  const code = text(body.code, 16)?.toUpperCase()
  const nickname = cleanNickname(text(body.nickname, 64) ?? '')
  const role = body.role === undefined ? undefined : (body.role as Role)
  if (!code || !nickname) return reply({ error: 'Servono il codice della stanza e un nome.' }, 400)
  if (role !== undefined && !ROLES.includes(role)) return reply({ error: `Ruoli: ${ROLES.join(', ')}.` }, 400)
  const limit = await claimJoin(req)
  if (limit) return reply({ error: limit }, 429)

  const playerId = crypto.randomUUID()
  const token = randomHex(24)
  const tokenHash = await sha256(token)
  const result = await run(code, (state, now) => {
    advance(state, now)
    const added = addPlayer(state, { id: playerId, tokenHash, nickname, role }, now)
    return added.error ? { state, error: added.error, isChanged: false } : { state, isChanged: true }
  })
  if (!result) {
    return reply({ error: `Nessuna nave ${code}: controlla il codice. Le navi ferme da ${ABANDONED_DAYS} giorni vengono smantellate.` }, 404)
  }
  if (result.error) return reply({ error: result.error })

  return reply({ code, playerId, token, view: toView(result.state, playerId, result.now) })
}

/** The ops a crew member makes once in the room, each answered with their view. */
async function member(op: string, body: Record<string, unknown>): Promise<Response> {
  const code = text(body.code, 16)?.toUpperCase()
  const playerId = text(body.playerId, 64)
  const token = text(body.token, 128)
  if (!code || !playerId || !token) return reply({ error: 'Richiesta incompleta.' }, 400)
  const tokenHash = await sha256(token)

  const result = await run(code, (state, now) => {
    advance(state, now)
    const player = state.players.find(p => p.id === playerId)
    if (!player || player.tokenHash !== tokenHash) return { state, error: BAD_CREDENTIALS, isChanged: false }

    if (op === 'sync') {
      if (body.isWaiting !== true || !beatChanges(state, playerId, now)) return { state, isChanged: false }
      beat(state, playerId, now)
      return { state, isChanged: true }
    }

    if (body.isWaiting === true) beat(state, playerId, now)
    const outcome =
      op === 'act'
        ? act(state, playerId, body.action as Action, now, typeof body.target === 'number' ? body.target : undefined)
        : op === 'signal'
          ? signal(state, playerId, body.signal as Signal, now)
          : changeRole(state, playerId, body.role as Role, now)
    return outcome.error ? { state, error: outcome.error, isChanged: false } : { state, isChanged: true }
  })

  if (!result) {
    return reply(
      { error: `La nave ${code} non esiste più: dopo ${ABANDONED_DAYS} giorni senza attività viene smantellata. Creane una con /deriva nuova <nome>.` },
      404,
    )
  }
  if (result.error === BAD_CREDENTIALS) return reply({ error: result.error }, 401)

  return reply({ error: result.error, view: toView(result.state, playerId, result.now) })
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: HEADERS })
  if (req.method !== 'POST') return reply({ error: 'Usa POST.' }, 405)

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return reply({ error: 'Richiesta troppo grande.' }, 413)
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return reply({ error: 'JSON non valido.' }, 400)
  }

  try {
    switch (body.op) {
      case 'create':
        return await create(req, body)
      case 'join':
        return await join(req, body)
      case 'sync':
      case 'act':
      case 'signal':
      case 'role':
        if (body.op === 'act' && !(String(body.action) in ACTIONS)) return reply({ error: 'Azione sconosciuta.' }, 400)
        if (body.op === 'signal' && !(String(body.signal) in SIGNALS)) return reply({ error: 'Segnale sconosciuto.' }, 400)
        return await member(body.op, body)
      default:
        return reply({ error: 'Operazione sconosciuta.' }, 400)
    }
  } catch (error) {
    console.error(error)
    return reply({ error: 'Errore del server, riprova tra poco.' }, 500)
  }
})
