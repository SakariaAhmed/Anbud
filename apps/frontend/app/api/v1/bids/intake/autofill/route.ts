import { NextRequest, NextResponse } from "next/server";

import { extractIntakeFromDocument } from "@/lib/server/ai";
import { extractTextFromUpload } from "@/lib/server/documents";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "File is required" }, { status: 400 });
  }

  try {
    const parsed = await extractTextFromUpload(file);
    const suggestion = await extractIntakeFromDocument(parsed.rawText);
    return NextResponse.json(suggestion);
  } catch (error) {
    return NextResponse.json({ detail: error instanceof Error ? error.message : "Failed to extract intake" }, { status: 400 });
  }
}
