import { useState } from "react";

export default function DisputeModal({
  match,
  onClose,
  onSubmitDispute,
  submitting
}) {
  const [reason, setReason] = useState("");

  if (!match) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onSubmitDispute(match._id, reason.trim());
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <section className="report-modal auth-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="section-kicker"><span /> CLAIM DISPUTE</div>
            <h2>Dispute this match<span>.</span></h2>
            <p>An administrator will review your notes and the claim history.</p>
          </div>
          <button className="modal-close" onClick={onClose} disabled={submitting}>
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="report-form">
          <label>
            Reason for dispute
            <textarea
              style={{
                width: "100%",
                minHeight: "90px",
                padding: "10px",
                borderRadius: "7px",
                border: "1px solid #e3e3d8",
                fontFamily: "inherit"
              }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The item color does not match, or finder refused handover..."
              required
              maxLength={400}
            />
          </label>

          <button className="button button-dark submit-button" disabled={submitting || !reason.trim()}>
            {submitting ? "Submitting dispute..." : "Submit dispute to admin"} <span>↗</span>
          </button>
        </form>
      </section>
    </div>
  );
}
