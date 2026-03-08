"use client";

import { FormEvent, useState } from "react";

import { Phase } from "@/lib/types";

const API_BASE = "";

const PHASES: Phase[] = [
  "Intake",
  "Discovery",
  "Q&A",
  "Solutioning",
  "Pricing",
  "Internal Review",
  "Submit",
  "Negotiation",
  "Awarded",
  "Lost"
];

export function AddBidRoundForm({ tenderId }: { tenderId: string }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    const nextActionsRaw = String(data.get("next_actions") ?? "");
    const nextActions = nextActionsRaw
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);

    const payload = {
      phase: String(data.get("phase") ?? "Intake"),
      status: String(data.get("status") ?? "active"),
      deadline: String(data.get("deadline") ?? "") || null,
      next_actions: nextActions
    };

    const file = data.get("document") as File | null;

    setLoading(true);
    setStatus("Creating bid round...");

    try {
      const roundRes = await fetch(`${API_BASE}/api/v1/tenders/${tenderId}/bid-rounds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify(payload)
      });

      if (!roundRes.ok) {
        throw new Error(`Bid round failed (${roundRes.status})`);
      }

      if (file && file.size > 0) {
        setStatus("Uploading related document...");
        const docData = new FormData();
        docData.append("file", file);

        const docRes = await fetch(`${API_BASE}/api/v1/tenders/${tenderId}/documents`, {
          method: "POST",
          headers: {
            "x-tenant-id": "default",
            "x-user-name": "dashboard-user"
          },
          body: docData
        });

        if (!docRes.ok) {
          throw new Error(`Document upload failed (${docRes.status})`);
        }
      }

      setStatus("Bid round added. Reloading...");
      form.reset();
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="panel form-panel">
      <h2>Add Bid Round + Document</h2>
      <form className="ops-form" onSubmit={onSubmit}>
        <label>
          Phase
          <select defaultValue="Intake" name="phase">
            {PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <input defaultValue="active" name="status" type="text" />
        </label>
        <label>
          Deadline
          <input name="deadline" type="date" />
        </label>
        <label>
          Next actions (one per line)
          <textarea name="next_actions" rows={4} />
        </label>
        <label>
          Related document (PDF or TXT)
          <input accept=".pdf,.txt,text/plain,application/pdf" name="document" type="file" />
        </label>
        <button disabled={loading} type="submit">
          {loading ? "Saving..." : "Add Bid Round"}
        </button>
      </form>
      <p className="form-status">{status}</p>
    </article>
  );
}
