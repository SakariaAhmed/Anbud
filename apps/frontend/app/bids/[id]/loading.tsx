export default function BidLoadingPage() {
  return (
    <div className="content-stack">
      <section className="workspace-shell">
        <header className="page-header">
          <div>
            <p className="kicker">Bid Workspace</p>
            <div className="loading-line title" />
            <div className="loading-line subtitle" />
          </div>
          <div className="section-tabs">
            <span className="section-tab">Overview</span>
            <span className="section-tab">Chat</span>
            <span className="section-tab">Requirements</span>
          </div>
        </header>

        <article className="panel">
          <div className="loading-stack">
            <div className="loading-line block" />
            <div className="loading-line block" />
            <div className="loading-line block short" />
          </div>
        </article>
      </section>
    </div>
  );
}
