import { createBrowserClient } from '@supabase/ssr'

// During Docker builds, NEXT_PUBLIC_* vars are placeholder sentinels
// (e.g. __NEXT_PUBLIC_SUPABASE_URL__) that get replaced at runtime by
// docker-entrypoint.sh. Provide a dummy URL so the client constructor
// doesn't throw during Next.js static page generation.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

// HT patch: the root layout renders the CURRENT values into the HTML
// (window.__SUPABASE_PUBLIC__, see src/app/layout.tsx). The values inlined
// above live in a chunk whose filename does not change when the env changes,
// and chunks are cached immutable for a year: after the 2026-10-15 move off
// Supabase Cloud, browsers kept talking to the old project. HTML is never
// cached that way, so it wins; the inlined values are the fallback.
type PublicSupabaseConfig = { url?: string; anonKey?: string }
function runtimeConfig(): PublicSupabaseConfig {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { __SUPABASE_PUBLIC__?: PublicSupabaseConfig }).__SUPABASE_PUBLIC__ ?? {}
}

// Cookie encoding must match lib/supabase/server.ts (default
// `user-and-tokens`); see the note there before switching to `tokens-only`.
export function createClient() {
  const runtime = runtimeConfig()
  const u = runtime.url || url
  const k = runtime.anonKey || key
  const isBuildPlaceholder = !u || u.startsWith('__')
  return createBrowserClient(
    isBuildPlaceholder ? 'https://placeholder.supabase.co' : u,
    isBuildPlaceholder ? 'placeholder' : k
  )
}
