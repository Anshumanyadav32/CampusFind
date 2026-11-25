import { useState } from "react";
import axios from "axios";
import { getItemIcon } from "../utils/itemIcons.js";

export default function ProfileView({
  profileLoading,
  profileData,
  profileForm,
  setProfileForm,
  saveProfile,
  profileSaving,
  API_BASE_URL,
  onHandoverSuccess,
  confirmMatch,
  confirmingMatchId,
  onOpenDispute,
  onWithdrawClaim,
  openReport,
  openProfile,
  setActivePage
}) {
  const [handoverState, setHandoverState] = useState({});
  const [handoverSubmitting, setHandoverSubmitting] = useState({});
  const reports = profileData?.reports || [];
  const activeReports = reports.filter((item) => item.status !== "returned");
  const returnedReports = reports.filter((item) => item.status === "returned");

  async function submitHandoverOtp(claim) {
    if (handoverSubmitting[claim._id]) return;
    const otp = String(handoverState[claim._id]?.otp || "").trim();
    if (!/^\d{6}$/.test(otp)) {
      setHandoverState((previous) => ({
        ...previous,
        [claim._id]: { ...previous[claim._id], otp, error: "Enter a six-digit OTP." }
      }));
      return;
    }

    setHandoverSubmitting((previous) => ({ ...previous, [claim._id]: true }));
    setHandoverState((previous) => ({
      ...previous,
      [claim._id]: { ...previous[claim._id], otp, error: "", success: "" }
    }));

    try {
      const response = await axios.post(
        `${API_BASE_URL}/claims/${encodeURIComponent(claim._id)}/handover/verify`,
        { otp }
      );
      setHandoverState((previous) => ({
        ...previous,
        [claim._id]: { otp: "", error: "", success: response.data.message || "Handover verified successfully." }
      }));
      if (onHandoverSuccess) await onHandoverSuccess();
    } catch (error) {
      setHandoverState((previous) => ({
        ...previous,
        [claim._id]: {
          ...previous[claim._id],
          error: error.response?.data?.message || "Could not verify the handover OTP."
        }
      }));
    } finally {
      setHandoverSubmitting((previous) => ({ ...previous, [claim._id]: false }));
    }
  }

  function renderReportCards(items) {
    return (
      <div className="items-grid">
        {items.map((item, index) => {
          const updatedAt = item.updatedAt ? new Date(item.updatedAt) : null;
          const returnedDate = updatedAt && !Number.isNaN(updatedAt.getTime())
            ? ` · ${updatedAt.toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric"
              })}`
            : "";

          return (
            <article className="item-card" key={item._id}>
              <div className={`item-visual visual-${index % 5}`}>
                <span className="visual-decoration decoration-one">✳</span>
                <span className="item-symbol">{getItemIcon(item)}</span>
                <span className={`status-pill ${item.reportType}`}>
                  <span /> {item.reportType === "lost" ? "LOST ITEM" : "FOUND ITEM"}
                </span>
              </div>
              <div className="item-info">
                <div className="item-category-row">
                  <span className="item-category">{item.category}</span>
                  <span className="item-date">
                    {item.dateReported
                      ? new Date(item.dateReported).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                        })
                      : ""}
                  </span>
                </div>
                <h3>{item.itemName}</h3>
                <div className="item-detail">
                  <span>◉</span> {item.color}
                </div>
                <div className="item-detail">
                  <span>⌖</span> {item.location}
                </div>
                <div className="item-card-footer">
                  <span className="item-status-text">
                    {item.status === "returned"
                      ? `✓ RETURNED${returnedDate}`
                      : item.reportType === "lost"
                        ? "Still looking"
                        : "Waiting for owner"}
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <main className="profile-page">
      <section className="profile-heading">
        <div>
          <div className="section-kicker"><span /> YOUR CAMPUS ACCOUNT</div>
          <h1>My profile<span>.</span></h1>
          <p>Manage your account details and keep track of your reports.</p>
        </div>
        <button className="button button-outline" onClick={() => setActivePage("home")}>
          Back to the board
        </button>
      </section>

      {profileLoading ? (
        <div className="state-panel">
          <div className="loader" />
          <p>Loading your profile...</p>
        </div>
      ) : profileData ? (
        <>
          <div className="profile-grid">
            <section className="profile-panel">
              <div className="profile-panel-heading">
                <span className="profile-avatar">
                  {(profileData.user.name || "S").slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2>{profileData.user.name}</h2>
                  <p>
                    Student ID · {profileData.user.studentId}
                    {profileData.user.role === "admin" && " (Administrator)"}
                  </p>
                </div>
              </div>

              <form className="profile-form" onSubmit={saveProfile}>
                <label>
                  Full name
                  <input
                    value={profileForm.name}
                    onChange={(event) =>
                      setProfileForm((previous) => ({ ...previous, name: event.target.value }))
                    }
                    maxLength={100}
                    required
                  />
                </label>
                <label>
                  Email address
                  <input
                    type="email"
                    value={profileForm.email}
                    onChange={(event) =>
                      setProfileForm((previous) => ({ ...previous, email: event.target.value }))
                    }
                    maxLength={254}
                    required
                  />
                </label>
                <label>
                  Student ID
                  <input value={profileData.user.studentId} readOnly />
                  <small>Your student ID cannot be changed here.</small>
                </label>
                <button className="button button-dark" disabled={profileSaving}>
                  {profileSaving ? "Saving..." : "Save changes"}
                </button>
              </form>
            </section>

            <section className="profile-summary">
              <span className="stat-icon stat-yellow">⌕</span>
              <div>
                <strong>{profileData.reports.length}</strong>
                <span>Your reports</span>
              </div>
              <div className="profile-summary-breakdown">
                <span>
                  {profileData.reports.filter((item) => item.reportType === "lost").length} lost
                </span>
                <span>
                  {profileData.reports.filter((item) => item.reportType === "found").length} found
                </span>
              </div>
            </section>
          </div>

          <section className="profile-matches">
            <div className="section-heading">
              <div>
                <div className="section-kicker"><span /> POSSIBLE REUNIONS</div>
                <h2>Potential matches<span>.</span></h2>
              </div>
            </div>

            {profileData.matches.length === 0 ? (
              <p className="profile-empty-note">
                New possible matches for your reports will show up here.
              </p>
            ) : (
              <div className="match-list">
                {profileData.matches.map((match) => (
                  <article className="match-row" key={match._id}>
                    <div>
                      <span className="match-label">LOST REPORT</span>
                      <strong>{match.lostItem?.itemName || "Report unavailable"}</strong>
                      <small>
                        {match.lostItem?.color} · {match.lostItem?.location}
                      </small>
                    </div>
                    <span className="match-connector">↔</span>
                    <div>
                      <span className="match-label">FOUND REPORT</span>
                      <strong>{match.foundItem?.itemName || "Report unavailable"}</strong>
                      <small>
                        {match.foundItem?.color} · {match.foundItem?.location}
                      </small>
                    </div>
                    <div className="match-meta">
                      <span>{match.matchScore}% match</span>
                      <small>
                        Status: <strong>{match.status}</strong>
                      </small>
                      {match.isLostReporter &&
                        ["pending", "confirming"].includes(match.status) && (
                          <div style={{ display: "flex", gap: "6px" }}>
                            <button
                              className="button button-dark"
                              disabled={confirmingMatchId === match._id}
                              onClick={() => confirmMatch(match)}
                            >
                              {confirmingMatchId === match._id
                                ? "Confirming..."
                                : match.status === "confirming"
                                  ? "Resume confirmation"
                                  : "Confirm returned"}
                            </button>
                            <button
                              className="button button-outline"
                              onClick={() => onOpenDispute(match)}
                              style={{ padding: "6px 10px", fontSize: "11px" }}
                            >
                              Dispute
                            </button>
                          </div>
                        )}
                      {match.status === "disputed" && (
                        <small style={{ color: "#b18c38" }}>Under admin review</small>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* User's Submitted Claims */}
          <section className="profile-matches">
            <div className="section-heading">
              <div>
                <div className="section-kicker"><span /> OWNERSHIP RECOVERY</div>
                <h2>My submitted claims<span>.</span></h2>
                <p>Track the status of your claims and administrative verification.</p>
              </div>
            </div>

            {(!profileData.claims || profileData.claims.length === 0) ? (
              <p className="profile-empty-note">
                You have not submitted any ownership claims yet. You can claim found items directly from the board or matches.
              </p>
            ) : (
              <div className="match-list">
                {profileData.claims.map((claim) => (
                  <article className="match-row" key={claim._id} style={{ alignItems: "flex-start" }}>
                    <div>
                      <span className="match-label">CLAIMED ITEM</span>
                      <strong>{claim.item?.itemName || "Item Report"}</strong>
                      <small>
                        {claim.item?.category} · {claim.item?.color} · {claim.item?.location}
                      </small>
                      <small style={{ color: "#777", marginTop: "4px", display: "block" }}>
                        Submitted on {new Date(claim.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </small>
                    </div>

                    <div style={{ flex: 1, minWidth: "220px" }}>
                      <span className="match-label">VERIFICATION DETAILS</span>
                      {claim.additionalDetails && (
                        <p style={{ margin: "2px 0 6px 0", fontSize: "13px", color: "#444" }}>
                          &ldquo;{claim.additionalDetails}&rdquo;
                        </p>
                      )}
                      {claim.status === "approved" && claim.handoverLocation && (
                        <div style={{ background: "#f3f8f3", borderLeft: "3px solid #274029", padding: "6px 10px", borderRadius: "4px", marginTop: "4px" }}>
                          <strong style={{ fontSize: "12px", color: "#274029" }}>Collection Desk:</strong>
                          <small style={{ display: "block", color: "#333" }}>{claim.handoverLocation}</small>
                        </div>
                      )}
                      {claim.status === "rejected" && claim.rejectionReason && (
                        <div style={{ background: "#fdf4f4", borderLeft: "3px solid #b12d2d", padding: "6px 10px", borderRadius: "4px", marginTop: "4px" }}>
                          <strong style={{ fontSize: "12px", color: "#b12d2d" }}>Rejection Reason:</strong>
                          <small style={{ display: "block", color: "#555" }}>{claim.rejectionReason}</small>
                        </div>
                      )}
                    </div>

                    <div className="match-meta" style={{ minWidth: "140px" }}>
                      <span
                        style={{
                          color:
                            claim.status === "approved"
                              ? "#274029"
                              : claim.status === "rejected"
                                ? "#b12d2d"
                                : claim.status === "under_review"
                                  ? "#b18c38"
                                  : "#4a5568",
                          fontWeight: "bold"
                        }}
                      >
                        {claim.status === "approved"
                          ? "APPROVED - AWAITING HANDOVER"
                          : claim.status === "returned"
                            ? "RETURNED SUCCESSFULLY"
                            : claim.status === "additional_evidence_required"
                              ? "ADDITIONAL EVIDENCE REQUIRED"
                              : claim.status.replaceAll("_", " ").toUpperCase()}
                      </span>
                      {["pending", "under_review", "additional_evidence_required", "flagged"].includes(claim.status) && onWithdrawClaim && (
                        <button
                          className="button button-outline"
                          onClick={() => onWithdrawClaim(claim)}
                          style={{ marginTop: "6px", fontSize: "11px", padding: "5px 8px", borderColor: "#b12d2d", color: "#b12d2d" }}
                        >
                          Withdraw claim
                        </button>
                      )}
                      {claim.status === "approved" && (
                        <div style={{ marginTop: "8px" }}>
                          {claim.handoverOtpEmailStatus === "sent" ? (
                            <small style={{ display: "block", color: "#274029", marginBottom: "6px" }}>
                              Handover OTP issued. Enter the six-digit code emailed to you.
                            </small>
                          ) : claim.handoverOtpEmailStatus === "failed" ? (
                            <small style={{ display: "block", color: "#b12d2d", marginBottom: "6px" }}>
                              The OTP email could not be delivered. Contact campus administration.
                            </small>
                          ) : claim.handoverOtpEmailStatus === "smtp_not_configured" ? (
                            <small style={{ display: "block", color: "#b12d2d", marginBottom: "6px" }}>
                              Email delivery is unavailable (SMTP not configured). Contact campus administration.
                            </small>
                          ) : (
                            <small style={{ display: "block", color: "#475569", marginBottom: "6px" }}>
                              Handover OTP issued. Awaiting email delivery confirmation.
                            </small>
                          )}
                          <input
                            aria-label="Six-digit handover OTP"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={handoverState[claim._id]?.otp || ""}
                            onChange={(event) => {
                              const otp = event.target.value.replace(/\D/g, "").slice(0, 6);
                              setHandoverState((previous) => ({
                                ...previous,
                                [claim._id]: { ...previous[claim._id], otp, error: "", success: "" }
                              }));
                            }}
                            style={{ width: "100%", boxSizing: "border-box", padding: "8px", borderRadius: "6px", border: "1px solid #ccc", marginBottom: "6px" }}
                          />
                          <button
                            type="button"
                            className="button button-dark"
                            disabled={Boolean(handoverSubmitting[claim._id])}
                            onClick={() => submitHandoverOtp(claim)}
                            style={{ width: "100%", fontSize: "12px" }}
                          >
                            {handoverSubmitting[claim._id] ? "Verifying..." : "Verify handover OTP"}
                          </button>
                          {handoverState[claim._id]?.error && (
                            <small style={{ display: "block", color: "#b12d2d", marginTop: "6px" }}>
                              {handoverState[claim._id].error}
                            </small>
                          )}
                          {handoverState[claim._id]?.success && (
                            <small style={{ display: "block", color: "#274029", marginTop: "6px" }}>
                              {handoverState[claim._id].success}
                            </small>
                          )}
                        </div>
                      )}
                      {claim.status === "returned" && (
                        <small style={{ display: "block", color: "#274029", marginTop: "6px" }}>
                          Handover completed successfully.
                          {claim.handoverDate
                            ? ` ${new Date(claim.handoverDate).toLocaleString("en-IN")}`
                            : ""}
                        </small>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="profile-reports">
            <div className="section-heading">
              <div>
                <div className="section-kicker"><span /> YOUR ACTIVITY</div>
                <h2>My active reports<span>.</span></h2>
              </div>
              <button className="button button-dark" onClick={() => openReport("lost")}>
                Report an item <span>↗</span>
              </button>
            </div>

            {activeReports.length === 0 ? (
              <div className="state-panel empty-panel">
                <span className="state-emoji">✳</span>
                <h3>No active reports.</h3>
                <p>Your active lost and found reports will appear here.</p>
              </div>
            ) : (
              renderReportCards(activeReports)
            )}
          </section>

          <section className="profile-reports">
            <div className="section-heading">
              <div>
                <div className="section-kicker"><span /> COMPLETED REPORTS</div>
                <h2>My report history<span>.</span></h2>
              </div>
            </div>
            {returnedReports.length === 0 ? (
              <p className="profile-empty-note">Returned reports will appear here.</p>
            ) : (
              renderReportCards(returnedReports)
            )}
          </section>
        </>
      ) : (
        <div className="state-panel">
          <span className="state-emoji">⚠</span>
          <h3>We couldn't load your profile.</h3>
          <button className="button button-dark" onClick={openProfile}>
            Try again ↻
          </button>
        </div>
      )}
    </main>
  );
}
