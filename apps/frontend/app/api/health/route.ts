import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "bidsite-frontend",
      runtime: "nextjs",
      supabase_configured: Boolean(
        process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
      ),
      openai_configured: Boolean(process.env.OPENAI_API_KEY),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
