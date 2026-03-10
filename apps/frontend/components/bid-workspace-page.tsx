"use client";

import { useEffect, useState } from "react";

import { BidWorkspace } from "@/components/bid-workspace";
import { BidBootstrapResponse } from "@/lib/types";
import { prefetchWorkspaceCache, readWorkspaceCache } from "@/lib/client/workspace-cache";

function toBootstrapPayload(cached: ReturnType<typeof readWorkspaceCache>): BidBootstrapResponse | null {
  if (!cached) {
    return null;
  }

  return {
    bid: cached.bid,
    documents: cached.documents,
    events: cached.events,
    notes: cached.notes,
    requirements: cached.requirements,
    decisions: cached.decisions,
    tasks: cached.tasks
  };
}

export function BidWorkspacePage({ bidId }: { bidId: string }) {
  const [bootstrap, setBootstrap] = useState<BidBootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const cached = toBootstrapPayload(readWorkspaceCache(bidId));
    if (cached) {
      setBootstrap(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    async function load() {
      const prefetched = await prefetchWorkspaceCache(bidId);
      if (!active) {
        return;
      }

      const prefetchedPayload = toBootstrapPayload(prefetched);
      if (prefetchedPayload) {
        setBootstrap(prefetchedPayload);
        setLoading(false);
        setError("");
        return;
      }

      const response = await fetch(`/api/v1/bids/${bidId}/bootstrap`, {
        headers: {
          "x-tenant-id": "default"
        }
      });

      if (!active) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        setError(payload.detail || `Failed to load bid (${response.status})`);
        setLoading(false);
        return;
      }

      const payload = (await response.json()) as BidBootstrapResponse;
      setBootstrap(payload);
      setLoading(false);
      setError("");
    }

    void load();

    return () => {
      active = false;
    };
  }, [bidId]);

  if (loading && !bootstrap) {
    return (
      <div className="content-stack">
        <section className="workspace-shell">
          <header className="page-header">
            <div>
              <p className="kicker">Bid Workspace</p>
              <div className="loading-line title" />
              <div className="loading-line subtitle" />
            </div>
          </header>
          <article className="panel">
            <div className="loading-stack">
              <div className="loading-line block" />
              <div className="loading-line block short" />
            </div>
          </article>
        </section>
      </div>
    );
  }

  if (error && !bootstrap) {
    return (
      <div className="content-stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Bid could not be loaded</h2>
            <p>{error}</p>
          </div>
        </section>
      </div>
    );
  }

  if (!bootstrap) {
    return null;
  }

  return (
    <div className="content-stack">
      <BidWorkspace
        initialBid={bootstrap.bid}
        initialDecisions={bootstrap.decisions}
        initialDocuments={bootstrap.documents}
        initialEvents={bootstrap.events}
        initialNotes={bootstrap.notes}
        initialRequirements={bootstrap.requirements}
        initialTasks={bootstrap.tasks}
      />
    </div>
  );
}
