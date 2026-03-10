import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { answerBidQuestion } from "@/lib/server/ai";
import { getBidOrThrow, logBidEvent, mapEvent, touchBidActivity } from "@/lib/server/bids-db";
import { actorFromHeaders, tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const actor = actorFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON payload" }, { status: 400 });
  }

  const question = String(payload.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ detail: "question is required" }, { status: 422 });
  }

  let bid;
  try {
    bid = await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  const { data: documents, error } = await supabase
    .from("bid_documents")
    .select("file_name, raw_text")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  const chatDocuments = (documents ?? [])
    .map((doc) => ({
      fileName: String(doc.file_name ?? "").trim() || "Unnamed document",
      rawText: String(doc.raw_text ?? "").trim()
    }))
    .filter((doc) => doc.rawText);

  const answer = await answerBidQuestion({
    question,
    documents: chatDocuments,
    bidContext: {
      customer_name: bid.customer_name,
      title: bid.title,
      owner: bid.owner,
      deadline: bid.deadline
    }
  });

  const questionEvent = await logBidEvent({
    tenantId,
    bidId: id,
    actor,
    type: "chat_question",
    payload: { question, source: "bid_chat" }
  });
  const answerEvent = await logBidEvent({
    tenantId,
    bidId: id,
    actor: "assistant",
    type: "chat_answer",
    payload: {
      answer: answer.answer,
      confidence: answer.confidence,
      citations: answer.citations,
      source: "bid_chat"
    }
  });
  await touchBidActivity(tenantId, id);
  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json({
    ...answer,
    question_event: mapEvent(questionEvent),
    answer_event: mapEvent(answerEvent)
  });
}
