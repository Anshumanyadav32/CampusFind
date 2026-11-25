import { useEffect, useState, useCallback } from "react";
import axios from "axios";

export default function AdminDashboard({
  currentUser,
  API_BASE_URL,
  onBackToBoard,
  onOpenAuth
}) {
  const isAdmin = currentUser?.role === "admin";
  const [activeTab, setActiveTab] = useState("overview"); // overview, claims, users, items, audit, disputes
  const [loading, setLoading] = useState(() => Boolean(isAdmin));
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [actionNoticeType, setActionNoticeType] = useState("success");

  // Overview Stats
  const [stats, setStats] = useState(null);

  // Claims Management
  const [claims, setClaims] = useState([]);
  const [claimsFilter, setClaimsFilter] = useState("all");
  const [claimsSearch, setClaimsSearch] = useState("");
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [claimActionLoading, setClaimActionLoading] = useState(false);
  const [claimReviewNotes, setClaimReviewNotes] = useState("");
  const [claimRejectionReason, setClaimRejectionReason] = useState("");
  const [claimHandoverLocation, setClaimHandoverLocation] = useState("Campus Security Central Desk");
  const [retryEmailLoading, setRetryEmailLoading] = useState(false);

  // User Management
  const [users, setUsers] = useState([]);
  const [usersFilter, setUsersFilter] = useState("all");
  const [usersSearch, setUsersSearch] = useState("");
  const [userModal, setUserModal] = useState(null); // { user, action: "suspend"|"deactivate"|"activate"|"reactivate" }
  const [userActionReason, setUserActionReason] = useState("");
  const [userActionLoading, setUserActionLoading] = useState(false);

  // Item Management & Moderation
  const [items, setItems] = useState([]);
  const [itemsFilter, setItemsFilter] = useState("all");
  const [itemsSearch, setItemsSearch] = useState("");
  const [itemModal, setItemModal] = useState(null); // { item, action: "flag"|"restore" }
  const [itemActionReason, setItemActionReason] = useState("");
  const [itemActionLoading, setItemActionLoading] = useState(false);

  // Audit Logs
  const [auditLogs, setAuditLogs] = useState([]);

  // Legacy Disputes
  const [disputes, setDisputes] = useState([]);
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [disputeNotes, setDisputeNotes] = useState("");
  const [disputeHandover, setDisputeHandover] = useState("Campus Security Central Desk");
  const [disputeLoading, setDisputeLoading] = useState(false);

  function getClaimProofUrl(filename) {
    if (filename.startsWith("http://") || filename.startsWith("https://")) return filename;
    return `${API_BASE_URL}/claims/proof/${encodeURIComponent(filename)}`;
  }

  function getPrivateItemPhotoUrl(itemId, filename) {
    return `${API_BASE_URL}/admin/items/${encodeURIComponent(itemId)}/private-images/${encodeURIComponent(filename)}`;
  }

  const loadStats = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/admin/stats`);
      setStats(res.data);
    } catch (err) {
      console.warn("Could not load stats:", err.message);
    }
  }, [API_BASE_URL]);

  const loadClaims = useCallback(async () => {
    try {
      const params = {};
      if (claimsFilter !== "all") params.status = claimsFilter;
      if (claimsSearch.trim()) params.q = claimsSearch.trim();
      const res = await axios.get(`${API_BASE_URL}/admin/claims`, { params });
      setClaims(res.data.claims || []);
    } catch (err) {
      console.warn("Could not load claims:", err.message);
    }
  }, [API_BASE_URL, claimsFilter, claimsSearch]);

  const loadUsers = useCallback(async () => {
    try {
      const params = {};
      if (usersFilter !== "all") params.status = usersFilter;
      if (usersSearch.trim()) params.q = usersSearch.trim();
      const res = await axios.get(`${API_BASE_URL}/admin/users`, { params });
      setUsers(res.data.users || []);
    } catch (err) {
      console.warn("Could not load users:", err.message);
    }
  }, [API_BASE_URL, usersFilter, usersSearch]);

  const loadItems = useCallback(async () => {
    try {
      const params = {};
      if (itemsFilter === "lost" || itemsFilter === "found") params.reportType = itemsFilter;
      if (itemsFilter === "flagged") params.moderationStatus = "flagged";
      if (itemsFilter === "returned") params.status = "returned";
      if (itemsSearch.trim()) params.q = itemsSearch.trim();
      const res = await axios.get(`${API_BASE_URL}/admin/items`, { params });
      setItems(res.data.items || []);
    } catch (err) {
      console.warn("Could not load items:", err.message);
    }
  }, [API_BASE_URL, itemsFilter, itemsSearch]);

  const loadAuditLogs = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/admin/audit-logs`);
      setAuditLogs(res.data.logs || []);
    } catch (err) {
      console.warn("Could not load audit logs:", err.message);
    }
  }, [API_BASE_URL]);

  const loadDisputes = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/admin/matches/disputed`);
      setDisputes(res.data.disputes || []);
    } catch (err) {
      console.warn("Could not load disputes:", err.message);
    }
  }, [API_BASE_URL]);

  const refreshCurrentTab = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await loadStats();
      if (activeTab === "overview") {
        await Promise.all([loadClaims(), loadUsers(), loadAuditLogs()]);
      } else if (activeTab === "claims") {
        await loadClaims();
      } else if (activeTab === "users") {
        await loadUsers();
      } else if (activeTab === "items") {
        await loadItems();
      } else if (activeTab === "audit") {
        await loadAuditLogs();
      } else if (activeTab === "disputes") {
        await loadDisputes();
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to refresh administration data.");
    } finally {
      setLoading(false);
    }
  }, [activeTab, loadStats, loadClaims, loadUsers, loadItems, loadAuditLogs, loadDisputes]);

  useEffect(() => {
    let ignore = false;
    if (isAdmin) {
      const load = async () => {
        try {
          await loadStats();
          if (activeTab === "overview") {
            await Promise.all([loadClaims(), loadUsers(), loadAuditLogs()]);
          } else if (activeTab === "claims") {
            await loadClaims();
          } else if (activeTab === "users") {
            await loadUsers();
          } else if (activeTab === "items") {
            await loadItems();
          } else if (activeTab === "audit") {
            await loadAuditLogs();
          } else if (activeTab === "disputes") {
            await loadDisputes();
          }
          if (!ignore) setLoading(false);
        } catch (err) {
          if (!ignore) {
            setError(err.response?.data?.message || "Failed to load administration data.");
            setLoading(false);
          }
        }
      };
      load();
    }
    return () => {
      ignore = true;
    };
  }, [isAdmin, activeTab, loadStats, loadClaims, loadUsers, loadItems, loadAuditLogs, loadDisputes]);

  // Handle Claim Resolution (Under Review, Approve, Reject)
  async function handleClaimStatusUpdate(status) {
    if (!selectedClaim) return;
    if (status === "rejected" && !claimRejectionReason.trim()) {
      setActionNoticeType("error");
      setActionNotice("A rejection reason is required when rejecting a claim.");
      return;
    }

    setClaimActionLoading(true);
    setActionNotice("");

    try {
      const res = await axios.patch(`${API_BASE_URL}/admin/claims/${selectedClaim._id}/status`, {
        status,
        reviewNotes: claimReviewNotes,
        rejectionReason: claimRejectionReason,
        handoverLocation: claimHandoverLocation
      });

      setActionNoticeType("success");
      setActionNotice(res.data.message || `Claim status updated to ${status}.`);
      setSelectedClaim(null);
      setClaimReviewNotes("");
      setClaimRejectionReason("");
      await loadClaims();
      await loadStats();
    } catch (err) {
      setActionNoticeType("error");
      setActionNotice(err.response?.data?.message || "Could not update claim status.");
    } finally {
      setClaimActionLoading(false);
    }
  }

  // Handle Retry Handover OTP Email
  async function handleRetryOtpEmail() {
    if (!selectedClaim) return;
    setRetryEmailLoading(true);
    setActionNotice("");

    try {
      const res = await axios.post(`${API_BASE_URL}/admin/claims/${selectedClaim._id}/handover/retry-email`);
      setActionNoticeType("success");
      setActionNotice(res.data.message || "Handover OTP email sent successfully.");
      setSelectedClaim((prev) => (prev ? {
        ...prev,
        handoverOtpEmailStatus: res.data.handoverOtpEmailStatus || "sent",
        handoverOtpEmailError: ""
      } : null));
      await loadClaims();
    } catch (err) {
      setActionNoticeType("error");
      const errorMsg = err.response?.data?.message || "Failed to retry OTP email delivery.";
      setActionNotice(errorMsg);
      if (err.response?.data?.handoverOtpEmailStatus) {
        setSelectedClaim((prev) => (prev ? {
          ...prev,
          handoverOtpEmailStatus: err.response.data.handoverOtpEmailStatus,
          handoverOtpEmailError: err.response.data.errorReason || errorMsg
        } : null));
      }
      await loadClaims();
    } finally {
      setRetryEmailLoading(false);
    }
  }

  // Handle User Account Status Change
  async function handleUserStatusSubmit() {
    if (!userModal) return;
    const { user, action } = userModal;
    const targetStatus = action === "suspend" ? "suspended" : action === "deactivate" ? "deactivated" : "active";

    setUserActionLoading(true);
    setActionNotice("");

    try {
      const res = await axios.patch(`${API_BASE_URL}/admin/users/${user.studentId}/status`, {
        status: targetStatus,
        reason: userActionReason
      });

      setActionNoticeType("success");
      setActionNotice(res.data.message || `User #${user.studentId} is now ${targetStatus}.`);
      setUserModal(null);
      setUserActionReason("");
      await loadUsers();
      await loadStats();
    } catch (err) {
      setActionNoticeType("error");
      setActionNotice(err.response?.data?.message || "Failed to update user account status.");
    } finally {
      setUserActionLoading(false);
    }
  }

  // Handle Item Moderation
  async function handleItemModerationSubmit() {
    if (!itemModal) return;
    const { item, action } = itemModal;
    const moderationStatus = action === "flag" ? "flagged" : "active";

    setItemActionLoading(true);
    setActionNotice("");

    try {
      const res = await axios.patch(`${API_BASE_URL}/admin/items/${item._id}/moderate`, {
        moderationStatus,
        reason: itemActionReason
      });

      setActionNoticeType("success");
      setActionNotice(res.data.message || `Item report status set to ${moderationStatus}.`);
      setItemModal(null);
      setItemActionReason("");
      await loadItems();
      await loadStats();
    } catch (err) {
      setActionNoticeType("error");
      setActionNotice(err.response?.data?.message || "Failed to moderate item.");
    } finally {
      setItemActionLoading(false);
    }
  }

  // Handle Dispute Resolution
  async function handleDisputeResolve(decision) {
    if (!selectedDispute) return;
    setDisputeLoading(true);
    setActionNotice("");

    try {
      const res = await axios.patch(`${API_BASE_URL}/admin/matches/${selectedDispute._id}/resolve`, {
        decision,
        resolutionNotes: disputeNotes,
        handoverLocation: disputeHandover
      });

      setActionNoticeType("success");
      setActionNotice(res.data.message || "Dispute resolved successfully.");
      setSelectedDispute(null);
      setDisputeNotes("");
      await loadDisputes();
      await loadStats();
    } catch (err) {
      setActionNoticeType("error");
      setActionNotice(err.response?.data?.message || "Could not resolve dispute.");
    } finally {
      setDisputeLoading(false);
    }
  }

  // Access Control Guard
  if (!currentUser || currentUser.role !== "admin") {
    return (
      <main className="profile-page">
        <section className="profile-heading">
          <div>
            <div className="section-kicker"><span /> RESTRICTED ACCESS</div>
            <h1>Campus Administration<span>.</span></h1>
            <p>Access to the administration and claim verification portal requires authorized staff privileges.</p>
          </div>
          <button className="button button-outline" onClick={onBackToBoard}>
            Back to Public Board
          </button>
        </section>

        <div className="state-panel">
          <span className="state-emoji">🔒</span>
          <h3>Administrator Sign-in Required</h3>
          <p>
            {currentUser
              ? `Signed in as student #${currentUser.studentId} (${currentUser.name}). This account does not have administrator permissions.`
              : "Please sign in with your campus administrative credentials."}
          </p>
          {!currentUser && (
            <button className="button button-dark" onClick={onOpenAuth} style={{ marginTop: "15px" }}>
              Sign in as Administrator ↗
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="profile-page">
      <section className="profile-heading">
        <div>
          <div className="section-kicker"><span /> CAMPUS CONTROL PORTAL</div>
          <h1>Security & Admin Portal<span>.</span></h1>
          <p>Manage ownership claim verification, student accounts, item moderation, and system audit logs.</p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="button button-dark" onClick={refreshCurrentTab}>
            Refresh ↻
          </button>
          <button className="button button-outline" onClick={onBackToBoard}>
            Back to Board ↗
          </button>
        </div>
      </section>

      {actionNotice && (
        <div className={`notice ${actionNoticeType}`} role="status" style={{ marginBottom: "20px" }}>
          <span>{actionNoticeType === "success" ? "✓" : "⚠"}</span> {actionNotice}
          <button onClick={() => setActionNotice("")}>×</button>
        </div>
      )}

      {/* Main Admin Navigation Tabs */}
      <div className="filter-tabs" style={{ marginBottom: "25px", flexWrap: "wrap", maxWidth: "900px" }}>
        <button
          className={activeTab === "overview" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("overview")}
        >
          Dashboard Overview
        </button>
        <button
          className={activeTab === "claims" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("claims")}
        >
          Claims Verification {stats?.claims?.pending ? `(${stats.claims.pending})` : ""}
        </button>
        <button
          className={activeTab === "users" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("users")}
        >
          User Accounts {stats?.users?.pending ? `(${stats.users.pending} pending)` : ""}
        </button>
        <button
          className={activeTab === "items" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("items")}
        >
          Item Moderation
        </button>
        <button
          className={activeTab === "disputes" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("disputes")}
        >
          Disputed Matches {stats?.activeDisputes ? `(${stats.activeDisputes})` : ""}
        </button>
        <button
          className={activeTab === "audit" ? "filter-tab selected" : "filter-tab"}
          onClick={() => setActiveTab("audit")}
        >
          Audit Trail
        </button>
      </div>

      {loading ? (
        <div className="state-panel">
          <div className="loader" />
          <p>Loading administration portal data...</p>
        </div>
      ) : error ? (
        <div className="state-panel">
          <span className="state-emoji">⚠</span>
          <h3>Administration Portal Error</h3>
          <p>{error}</p>
          <button className="button button-dark" onClick={refreshCurrentTab}>
            Try again ↻
          </button>
        </div>
      ) : (
        <>
          {/* =========================================================
              TAB 1: OVERVIEW & DASHBOARD METRICS
             ========================================================= */}
          {activeTab === "overview" && stats && (
            <section>
              <div className="section-heading" style={{ marginBottom: "20px" }}>
                <div>
                  <div className="section-kicker"><span /> LIVE SYSTEM METRICS</div>
                  <h2>Community Overview<span>.</span></h2>
                </div>
              </div>

              {/* 10+ Primary Metric Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "16px", marginBottom: "35px" }}>
                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-purple">👥</span>
                  <div>
                    <strong style={{ fontSize: "28px" }}>{stats.users?.total ?? 0}</strong>
                    <span>Total Users</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-green">✓</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#274029" }}>{stats.users?.active ?? 0}</strong>
                    <span>Active Users</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-yellow">⏳</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#b18c38" }}>{stats.users?.pending ?? 0}</strong>
                    <span>Pending Users</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px", border: "1px solid #f6dfe0" }}>
                  <span className="stat-icon" style={{ background: "#fdf0ed", color: "#b12d2d" }}>⚠</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#b12d2d" }}>
                      {(stats.users?.suspended ?? 0) + (stats.users?.deactivated ?? 0)}
                    </strong>
                    <span>Suspended / Inactive</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-purple">⌕</span>
                  <div>
                    <strong style={{ fontSize: "28px" }}>{stats.items?.lost ?? stats.lostItems ?? 0}</strong>
                    <span>Lost Reports</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-yellow">✳</span>
                  <div>
                    <strong style={{ fontSize: "28px" }}>{stats.items?.found ?? stats.foundItems ?? 0}</strong>
                    <span>Found Reports</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-green">★</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#274029" }}>{stats.items?.returned ?? stats.returnedItems ?? 0}</strong>
                    <span>Recovered / Returned</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px", border: "1px solid #f2d36c" }}>
                  <span className="stat-icon stat-yellow">📋</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#b18c38" }}>{stats.claims?.pending ?? 0}</strong>
                    <span>Pending Claims</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon stat-green">✓</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#274029" }}>{stats.claims?.approved ?? 0}</strong>
                    <span>Approved Claims</span>
                  </div>
                </div>

                <div className="profile-summary" style={{ padding: "16px" }}>
                  <span className="stat-icon" style={{ background: "#fdf0ed", color: "#b12d2d" }}>✕</span>
                  <div>
                    <strong style={{ fontSize: "28px", color: "#b12d2d" }}>{stats.claims?.rejected ?? 0}</strong>
                    <span>Rejected Claims</span>
                  </div>
                </div>
              </div>

              {/* Recent Pending Administrative Tasks */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "24px" }}>
                <div className="profile-panel" style={{ padding: "20px" }}>
                  <h3 style={{ margin: "0 0 12px 0", color: "#274029", fontSize: "18px" }}>
                    Pending Ownership Verification ({claims.filter((c) => c.status === "pending").length})
                  </h3>
                  {claims.filter((c) => c.status === "pending").length === 0 ? (
                    <p style={{ color: "#777", fontSize: "14px" }}>No claims currently awaiting verification.</p>
                  ) : (
                    <div style={{ display: "grid", gap: "10px" }}>
                      {claims
                        .filter((c) => c.status === "pending")
                        .slice(0, 4)
                        .map((c) => (
                          <div
                            key={c._id}
                            style={{
                              padding: "10px 12px",
                              background: "#fbfbf7",
                              border: "1px solid #e8e7dd",
                              borderRadius: "8px",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center"
                            }}
                          >
                            <div>
                              <strong>{c.item?.itemName || "Claimed Item"}</strong>
                              <small style={{ display: "block", color: "#666" }}>
                                Claimant: #{c.claimantId} ({c.claimantName})
                              </small>
                            </div>
                            <button
                              className="button button-outline"
                              onClick={() => {
                                setSelectedClaim(c);
                                setActiveTab("claims");
                              }}
                              style={{ padding: "6px 10px", fontSize: "12px" }}
                            >
                              Review ↗
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                <div className="profile-panel" style={{ padding: "20px" }}>
                  <h3 style={{ margin: "0 0 12px 0", color: "#274029", fontSize: "18px" }}>
                    Recent Audit Actions
                  </h3>
                  {auditLogs.length === 0 ? (
                    <p style={{ color: "#777", fontSize: "14px" }}>No recent audit events recorded.</p>
                  ) : (
                    <div style={{ display: "grid", gap: "8px" }}>
                      {auditLogs.slice(0, 5).map((log) => (
                        <div key={log._id} style={{ fontSize: "13px", padding: "6px 0", borderBottom: "1px solid #eee" }}>
                          <span style={{ fontWeight: "700", color: "#274029" }}>{log.action}</span>
                          <span style={{ color: "#888", marginLeft: "6px" }}>
                            {new Date(log.createdAt).toLocaleTimeString()}
                          </span>
                          <p style={{ margin: "2px 0 0 0", color: "#555" }}>
                            {log.details || log.reason || "Action performed by " + log.adminName}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* =========================================================
              TAB 2: CLAIM VERIFICATION MANAGEMENT
             ========================================================= */}
          {activeTab === "claims" && (
            <section className="profile-matches">
              <div className="section-heading">
                <div>
                  <div className="section-kicker"><span /> VERIFICATION WORKFLOW</div>
                  <h2>Ownership Claims Management<span>.</span></h2>
                  <p>Review claimant answers, inspect supporting receipts and photos, and authorize handovers.</p>
                </div>
              </div>

              {/* Filter Tabs & Search */}
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", marginBottom: "20px" }}>
                <div className="filter-tabs" style={{ margin: 0 }}>
                  {["all", "pending", "under_review", "additional_evidence_required", "approved", "returned", "rejected", "withdrawn", "flagged"].map((st) => (
                    <button
                      key={st}
                      className={claimsFilter === st ? "filter-tab selected" : "filter-tab"}
                      onClick={() => setClaimsFilter(st)}
                    >
                      {st.replace("_", " ").toUpperCase()}
                    </button>
                  ))}
                </div>
                <input
                  value={claimsSearch}
                  onChange={(e) => setClaimsSearch(e.target.value)}
                  placeholder="Search claims by claimant name, email, ID..."
                  style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "260px" }}
                />
              </div>

              {claims.length === 0 ? (
                <p className="profile-empty-note">No claims found matching your filter criteria.</p>
              ) : (
                <div className="match-list">
                  {claims.map((claim) => (
                    <article className="match-row" key={claim._id} style={{ alignItems: "flex-start" }}>
                      <div>
                        <span className="match-label">CLAIM #{String(claim._id).slice(-6).toUpperCase()}</span>
                        <strong>{claim.item?.itemName || "Claimed Item"}</strong>
                        <small>{claim.item?.category} · {claim.item?.color} · {claim.item?.location}</small>
                        <small style={{ color: "#777", marginTop: "4px", display: "block" }}>
                          Submitted: {new Date(claim.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </small>
                      </div>

                      <div style={{ flex: 1, minWidth: "220px" }}>
                        <span className="match-label">CLAIMANT: #{claim.claimantId} ({claim.claimantName})</span>
                        <small style={{ color: "#555", display: "block" }}>{claim.claimantEmail}</small>
                        {claim.additionalDetails && (
                          <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#333", fontStyle: "italic" }}>
                            &ldquo;{claim.additionalDetails}&rdquo;
                          </p>
                        )}
                        {Array.isArray(claim.proofFiles) && claim.proofFiles.length > 0 && (
                          <small style={{ color: "#274029", fontWeight: "bold", marginTop: "4px", display: "block" }}>
                            📎 {claim.proofFiles.length} proof file(s) attached
                          </small>
                        )}
                      </div>

                      <div className="match-meta" style={{ minWidth: "150px" }}>
                        <span
                          style={{
                            fontWeight: "bold",
                            color:
                              claim.status === "approved"
                                ? "#274029"
                                : claim.status === "rejected"
                                  ? "#b12d2d"
                                  : claim.status === "under_review"
                                    ? "#b18c38"
                                    : "#4a5568"
                          }}
                        >
                          {claim.status.replace("_", " ").toUpperCase()}
                        </span>
                        {claim.status === "approved" && (
                          <small
                            style={{
                              display: "block",
                              marginTop: "2px",
                              fontSize: "11px",
                              fontWeight: "600",
                              color:
                                claim.handoverOtpEmailStatus === "sent"
                                  ? "#274029"
                                  : claim.handoverOtpEmailStatus === "failed" ||
                                    claim.handoverOtpEmailStatus === "smtp_not_configured"
                                    ? "#b12d2d"
                                    : "#b18c38"
                            }}
                          >
                            OTP: {claim.handoverOtpEmailStatus === "sent"
                              ? "Sent"
                              : claim.handoverOtpEmailStatus === "failed"
                                ? "Failed"
                                : claim.handoverOtpEmailStatus === "smtp_not_configured"
                                  ? "SMTP Not Configured"
                                  : "Pending"}
                          </small>
                        )}
                        <button
                          className="button button-dark"
                          onClick={() => {
                            setSelectedClaim(claim);
                            setClaimReviewNotes(claim.reviewNotes || "");
                            setClaimRejectionReason(claim.rejectionReason || "");
                            setClaimHandoverLocation(claim.handoverLocation || "Campus Security Central Desk");
                          }}
                          style={{ marginTop: "8px", fontSize: "12px", padding: "6px 12px" }}
                        >
                          Inspect & Verify ↗
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {/* Claim Review & Arbitration Modal */}
              {selectedClaim && (
                <div
                  className="modal-backdrop"
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget && !claimActionLoading) setSelectedClaim(null);
                  }}
                >
                  <section className="report-modal" style={{ maxWidth: "700px", maxHeight: "90vh", overflowY: "auto" }}>
                    <div className="modal-header">
                      <div>
                        <div className="section-kicker"><span /> CLAIM ARBITRATION</div>
                        <h2>Review Claim & Proof<span>.</span></h2>
                        <p>Verify private marks and evidence before authorizing handover.</p>
                      </div>
                      <button className="modal-close" onClick={() => setSelectedClaim(null)} disabled={claimActionLoading}>
                        ×
                      </button>
                    </div>

                    <div style={{ background: "#fbfbf7", padding: "16px", borderRadius: "8px", margin: "15px 0" }}>
                      <h4 style={{ margin: "0 0 10px 0", color: "#274029" }}>Item & Claimant Overview:</h4>
                      <p><strong>Item:</strong> {selectedClaim.item?.itemName} ({selectedClaim.item?.category} - {selectedClaim.item?.color})</p>
                      <p><strong>Claimant:</strong> {selectedClaim.claimantName} (#{selectedClaim.claimantId}) · {selectedClaim.claimantEmail}</p>
                      {typeof selectedClaim.riskScore === "number" && (
                        <p style={{ color: selectedClaim.riskScore >= 50 ? "#b12d2d" : selectedClaim.riskScore >= 20 ? "#9a6a16" : "#274029" }}>
                          <strong>Internal Risk:</strong> {selectedClaim.riskScore}/100 · {selectedClaim.riskCategory}
                          {Array.isArray(selectedClaim.riskFactors) && selectedClaim.riskFactors.length > 0
                            ? ` · ${selectedClaim.riskFactors.join(", ")}`
                            : ""}
                        </p>
                      )}

                      {selectedClaim.status === "approved" && (
                        <div style={{ margin: "10px 0", padding: "10px 12px", background: "#f1f3f0", borderRadius: "6px", border: "1px solid #e0e3de" }}>
                          <p style={{ margin: "0 0 4px 0" }}>
                            <strong>Handover OTP Delivery Status:</strong>{" "}
                            <span
                              style={{
                                fontWeight: "bold",
                                color:
                                  selectedClaim.handoverOtpEmailStatus === "sent"
                                    ? "#274029"
                                    : selectedClaim.handoverOtpEmailStatus === "failed" ||
                                      selectedClaim.handoverOtpEmailStatus === "smtp_not_configured"
                                      ? "#b12d2d"
                                      : "#b18c38"
                              }}
                            >
                              {selectedClaim.handoverOtpEmailStatus === "sent"
                                ? "Sent"
                                : selectedClaim.handoverOtpEmailStatus === "failed"
                                  ? "Failed"
                                  : selectedClaim.handoverOtpEmailStatus === "smtp_not_configured"
                                    ? "SMTP Not Configured"
                                    : "Pending"}
                            </span>
                          </p>
                          {selectedClaim.handoverOtpEmailError && (
                            <p style={{ margin: "4px 0", fontSize: "12px", color: "#b12d2d" }}>
                              <strong>Failure Reason:</strong> {selectedClaim.handoverOtpEmailError}
                            </p>
                          )}
                          {selectedClaim.handoverOtpEmailStatus === "smtp_not_configured" && (
                            <p style={{ margin: "4px 0", fontSize: "12px", color: "#666" }}>
                              SMTP settings are missing. Configure <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, and <code>SMTP_PASS</code> in <code>backend/.env</code>.
                            </p>
                          )}
                          {["failed", "smtp_not_configured", "pending"].includes(selectedClaim.handoverOtpEmailStatus) && (
                            <button
                              type="button"
                              className="button button-outline"
                              onClick={handleRetryOtpEmail}
                              disabled={retryEmailLoading}
                              style={{ marginTop: "6px", fontSize: "12px", padding: "5px 10px" }}
                            >
                              {retryEmailLoading ? "Retrying..." : "Retry OTP Email ↻"}
                            </button>
                          )}
                        </div>
                      )}
                      {selectedClaim.status === "returned" && (
                        <p><strong>Handover completed:</strong> {selectedClaim.handoverDate ? new Date(selectedClaim.handoverDate).toLocaleString("en-IN") : "Timestamp unavailable"}</p>
                      )}

                      {/* Secret verification details comparison (exclusive to admin) */}
                      {selectedClaim.item?.brand && (
                        <p style={{ color: "#274029" }}><strong>Reporter&apos;s Brand:</strong> {selectedClaim.item.brand}</p>
                      )}
                      {selectedClaim.item?.model && (
                        <p style={{ color: "#274029" }}><strong>Reporter&apos;s Model:</strong> {selectedClaim.item.model}</p>
                      )}
                      {selectedClaim.item?.serialNumber && (
                        <p style={{ color: "#274029" }}><strong>Reporter&apos;s Secret Serial #:</strong> <code>{selectedClaim.item.serialNumber}</code></p>
                      )}
                      {selectedClaim.item?.identifyingMarks && (
                        <p style={{ color: "#274029" }}><strong>Reporter&apos;s Secret Marks:</strong> {selectedClaim.item.identifyingMarks}</p>
                      )}
                      {Array.isArray(selectedClaim.item?.privateImages) &&
                        selectedClaim.item.privateImages.some((filename) => filename.startsWith("proof-")) && (
                          <div style={{ marginTop: "10px" }}>
                            <span className="match-label">PRIVATE VERIFICATION PHOTOS:</span>
                            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "8px" }}>
                              {selectedClaim.item.privateImages
                                .filter((filename) => filename.startsWith("proof-"))
                                .map((filename) => (
                                  <a
                                    key={filename}
                                    href={getPrivateItemPhotoUrl(selectedClaim.item._id, filename)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <img
                                      src={getPrivateItemPhotoUrl(selectedClaim.item._id, filename)}
                                      crossOrigin="use-credentials"
                                      alt="Private item verification"
                                      style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "6px", border: "1px solid #ddd" }}
                                    />
                                  </a>
                                ))}
                            </div>
                          </div>
                        )}

                      {/* Claimant Answers */}
                      <div style={{ marginTop: "12px", borderTop: "1px solid #e8e7dd", paddingTop: "10px" }}>
                        <span className="match-label">CLAIMANT&apos;S VERIFICATION ANSWERS:</span>
                        {Array.isArray(selectedClaim.verificationAnswers) && selectedClaim.verificationAnswers.length > 0 ? (
                          selectedClaim.verificationAnswers.map((va, i) => (
                            <div key={i} style={{ margin: "4px 0", fontSize: "13px" }}>
                              <strong>{va.question}:</strong> <span style={{ color: "#333" }}>{va.answer}</span>
                            </div>
                          ))
                        ) : (
                          <p style={{ fontSize: "13px", color: "#777" }}>No specific Q&A submitted.</p>
                        )}
                        {selectedClaim.additionalDetails && (
                          <div style={{ marginTop: "8px", fontSize: "13px" }}>
                            <strong>Ownership Details:</strong> <p style={{ margin: "2px 0", color: "#444" }}>{selectedClaim.additionalDetails}</p>
                          </div>
                        )}
                      </div>

                      {/* Supporting Evidence Proof Previews */}
                      {Array.isArray(selectedClaim.proofFiles) && selectedClaim.proofFiles.length > 0 && (
                        <div style={{ marginTop: "14px", borderTop: "1px solid #e8e7dd", paddingTop: "10px" }}>
                          <span className="match-label">SUPPORTING EVIDENCE UPLOADED:</span>
                          <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                            {selectedClaim.proofFiles.map((url, i) => (
                              <a key={i} href={getClaimProofUrl(url)} target="_blank" rel="noopener noreferrer">
                                {url.toLowerCase().endsWith(".pdf") || url.toLowerCase().includes(".pdf") ? (
                                  <div style={{ width: "80px", height: "80px", border: "1px solid #ccc", borderRadius: "6px", display: "grid", placeItems: "center", background: "#fee", color: "#b12d2d", fontWeight: "bold" }}>
                                    📄 PDF
                                  </div>
                                ) : (
                                  <img src={getClaimProofUrl(url)} crossOrigin="use-credentials" alt="Proof" style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "6px", border: "1px solid #ddd" }} />
                                )}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Claim History Timeline */}
                    {Array.isArray(selectedClaim.claimHistory) && selectedClaim.claimHistory.length > 0 && (
                      <div style={{ margin: "16px 0" }}>
                        <h4 style={{ margin: "0 0 8px 0", color: "#274029" }}>Claim Audit Trail:</h4>
                        <div style={{ borderLeft: "2px solid #b18c38", paddingLeft: "12px", display: "grid", gap: "8px" }}>
                          {selectedClaim.claimHistory.map((item, idx) => (
                            <div key={idx} style={{ fontSize: "12px" }}>
                              <strong style={{ color: "#274029" }}>{item.action.toUpperCase()}</strong>
                              <span style={{ color: "#888", marginLeft: "6px" }}>
                                by {item.role} #{item.performedBy} ({new Date(item.timestamp).toLocaleTimeString()})
                              </span>
                              <p style={{ margin: "2px 0 0 0", color: "#555" }}>{item.details}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Arbitration Controls */}
                    <div className="report-form" style={{ marginTop: "15px" }}>
                      <label>
                        Handover Collection Desk (if approved)
                        <input
                          value={claimHandoverLocation}
                          onChange={(e) => setClaimHandoverLocation(e.target.value)}
                          placeholder="e.g. Central Security Desk, Building A"
                        />
                      </label>

                      <label>
                        Administrative Review Notes
                        <textarea
                          rows={2}
                          value={claimReviewNotes}
                          onChange={(e) => setClaimReviewNotes(e.target.value)}
                          placeholder="Internal verification notes, ID check results..."
                          style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ccc", fontFamily: "inherit" }}
                        />
                      </label>

                      <label>
                        Rejection Reason (Required only if rejecting)
                        <input
                          value={claimRejectionReason}
                          onChange={(e) => setClaimRejectionReason(e.target.value)}
                          placeholder="e.g. Verification answers and serial number did not match..."
                        />
                      </label>

                      <div style={{ display: "flex", gap: "10px", marginTop: "15px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="button button-dark"
                          onClick={() => handleClaimStatusUpdate("approved")}
                          disabled={claimActionLoading}
                          style={{ background: "#274029", flex: 1 }}
                        >
                          {claimActionLoading ? "Saving..." : "Approve Claim & Issue Handover OTP ✓"}
                        </button>
                        <button
                          type="button"
                          className="button button-outline"
                          onClick={() => handleClaimStatusUpdate("additional_evidence_required")}
                          disabled={claimActionLoading}
                          style={{ flex: 1 }}
                        >
                          Request Additional Evidence
                        </button>
                        <button
                          type="button"
                          className="button button-outline"
                          onClick={() => handleClaimStatusUpdate("under_review")}
                          disabled={claimActionLoading}
                          style={{ flex: 1 }}
                        >
                          Mark Under Review ⏳
                        </button>
                        <button
                          type="button"
                          className="button button-outline"
                          onClick={() => handleClaimStatusUpdate("rejected")}
                          disabled={claimActionLoading}
                          style={{ borderColor: "#b12d2d", color: "#b12d2d", flex: 1 }}
                        >
                          Reject Claim ✕
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </section>
          )}

          {/* =========================================================
              TAB 3: USER ACCOUNT MANAGEMENT
             ========================================================= */}
          {activeTab === "users" && (
            <section className="profile-reports">
              <div className="section-heading">
                <div>
                  <div className="section-kicker"><span /> ACCESS CONTROL</div>
                  <h2>Student & User Accounts<span>.</span></h2>
                  <p>Manage account activation, monitor reporting activity, and suspend fraudulent accounts.</p>
                </div>
              </div>

              {/* Filters & Search */}
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", marginBottom: "20px" }}>
                <div className="filter-tabs" style={{ margin: 0 }}>
                  {["all", "active", "pending", "suspended", "deactivated"].map((st) => (
                    <button
                      key={st}
                      className={usersFilter === st ? "filter-tab selected" : "filter-tab"}
                      onClick={() => setUsersFilter(st)}
                    >
                      {st.toUpperCase()}
                    </button>
                  ))}
                </div>
                <input
                  value={usersSearch}
                  onChange={(e) => setUsersSearch(e.target.value)}
                  placeholder="Search by student ID, name, email..."
                  style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "260px" }}
                />
              </div>

              {users.length === 0 ? (
                <p className="profile-empty-note">No users found matching your search filter.</p>
              ) : (
                <div className="match-list">
                  {users.map((u) => (
                    <article className="match-row" key={u.id || u.studentId} style={{ alignItems: "center" }}>
                      <div>
                        <span className="match-label">STUDENT #{u.studentId} {u.role === "admin" ? "(ADMIN)" : ""}</span>
                        <strong>{u.name}</strong>
                        <small>{u.email}</small>
                        <small style={{ color: "#777", display: "block", marginTop: "2px" }}>
                          Joined: {new Date(u.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                        </small>
                      </div>

                      <div style={{ minWidth: "160px" }}>
                        <span className="match-label">ACTIVITY</span>
                        <small style={{ display: "block" }}><strong>{u.reportsCount || 0}</strong> item reports</small>
                        <small style={{ display: "block" }}><strong>{u.claimsCount || 0}</strong> claims submitted</small>
                      </div>

                      <div className="match-meta" style={{ minWidth: "180px" }}>
                        <span
                          style={{
                            fontWeight: "bold",
                            color:
                              u.accountStatus === "active"
                                ? "#274029"
                                : u.accountStatus === "pending"
                                  ? "#b18c38"
                                  : "#b12d2d"
                          }}
                        >
                          STATUS: {(u.accountStatus || "active").toUpperCase()}
                        </span>

                        {/* Action Buttons based on status */}
                        {u.role !== "admin" && (
                          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                            {u.accountStatus === "pending" && (
                              <button
                                className="button button-dark"
                                onClick={() => setUserModal({ user: u, action: "activate" })}
                                style={{ padding: "4px 8px", fontSize: "11px", background: "#274029" }}
                              >
                                Activate ✓
                              </button>
                            )}
                            {u.accountStatus === "active" && (
                              <>
                                <button
                                  className="button button-outline"
                                  onClick={() => setUserModal({ user: u, action: "suspend" })}
                                  style={{ padding: "4px 8px", fontSize: "11px", borderColor: "#b18c38", color: "#b18c38" }}
                                >
                                  Suspend ⚠
                                </button>
                                <button
                                  className="button button-outline"
                                  onClick={() => setUserModal({ user: u, action: "deactivate" })}
                                  style={{ padding: "4px 8px", fontSize: "11px", borderColor: "#b12d2d", color: "#b12d2d" }}
                                >
                                  Deactivate ✕
                                </button>
                              </>
                            )}
                            {["suspended", "deactivated"].includes(u.accountStatus) && (
                              <button
                                className="button button-dark"
                                onClick={() => setUserModal({ user: u, action: "reactivate" })}
                                style={{ padding: "4px 8px", fontSize: "11px", background: "#274029" }}
                              >
                                Reactivate ↺
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {/* User Action Confirmation Modal */}
              {userModal && (
                <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !userActionLoading) setUserModal(null); }}>
                  <section className="report-modal" style={{ maxWidth: "500px" }}>
                    <div className="modal-header">
                      <div>
                        <div className="section-kicker"><span /> ACCOUNT ACTION</div>
                        <h2>{userModal.action.toUpperCase()} Account<span>.</span></h2>
                        <p>User #{userModal.user.studentId} ({userModal.user.name})</p>
                      </div>
                      <button className="modal-close" onClick={() => setUserModal(null)} disabled={userActionLoading}>×</button>
                    </div>

                    <div className="report-form" style={{ marginTop: "15px" }}>
                      <label>
                        Administrative Reason for {userModal.action}
                        <textarea
                          required
                          rows={3}
                          value={userActionReason}
                          onChange={(e) => setUserActionReason(e.target.value)}
                          placeholder="Provide the reason for this account action (recorded in audit logs)..."
                          style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", fontFamily: "inherit" }}
                        />
                      </label>

                      <div style={{ display: "flex", gap: "10px", marginTop: "15px" }}>
                        <button
                          className="button button-dark"
                          onClick={handleUserStatusSubmit}
                          disabled={userActionLoading || !userActionReason.trim()}
                          style={{ flex: 1, background: userModal.action === "suspend" || userModal.action === "deactivate" ? "#b12d2d" : "#274029" }}
                        >
                          {userActionLoading ? "Processing..." : `Confirm ${userModal.action.toUpperCase()} ↗`}
                        </button>
                        <button className="button button-outline" onClick={() => setUserModal(null)} disabled={userActionLoading}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </section>
          )}

          {/* =========================================================
              TAB 4: ITEM MODERATION
             ========================================================= */}
          {activeTab === "items" && (
            <section className="profile-reports">
              <div className="section-heading">
                <div>
                  <div className="section-kicker"><span /> CONTENT MODERATION</div>
                  <h2>Reported Items Moderation<span>.</span></h2>
                  <p>Inspect active lost and found reports, and flag inappropriate or suspicious submissions.</p>
                </div>
              </div>

              {/* Filters */}
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", marginBottom: "20px" }}>
                <div className="filter-tabs" style={{ margin: 0 }}>
                  {["all", "lost", "found", "returned", "flagged"].map((st) => (
                    <button
                      key={st}
                      className={itemsFilter === st ? "filter-tab selected" : "filter-tab"}
                      onClick={() => setItemsFilter(st)}
                    >
                      {st.toUpperCase()}
                    </button>
                  ))}
                </div>
                <input
                  value={itemsSearch}
                  onChange={(e) => setItemsSearch(e.target.value)}
                  placeholder="Search items by name, color, location..."
                  style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid #ccc", minWidth: "260px" }}
                />
              </div>

              {items.length === 0 ? (
                <p className="profile-empty-note">No items found matching your moderation filter.</p>
              ) : (
                <div className="match-list">
                  {items.map((item) => (
                    <article className="match-row" key={item._id} style={{ alignItems: "center" }}>
                      <div>
                        <span className={`status-pill ${item.reportType}`} style={{ display: "inline-block", marginBottom: "4px" }}>
                          <span /> {item.reportType.toUpperCase()}
                        </span>
                        <strong>{item.itemName}</strong>
                        <small>{item.category} · {item.color} · {item.location}</small>
                        <small style={{ color: "#777", display: "block", marginTop: "2px" }}>
                          Reported by Student #{item.reportedBy} on {new Date(item.dateReported).toLocaleDateString()}
                        </small>
                      </div>

                      <div>
                        <span className="match-label">STATUS</span>
                        <small style={{ display: "block", fontWeight: "600" }}>State: {item.status}</small>
                        {item.moderationStatus === "flagged" && (
                          <small style={{ color: "#b12d2d", fontWeight: "bold" }}>⚠ FLAGGED FOR MODERATION</small>
                        )}
                        {item.claimsCount > 0 && (
                          <small style={{ color: "#274029", display: "block" }}>{item.claimsCount} claims submitted</small>
                        )}
                      </div>

                      <div className="match-meta" style={{ minWidth: "140px" }}>
                        {item.moderationStatus === "flagged" ? (
                          <button
                            className="button button-dark"
                            onClick={() => setItemModal({ item, action: "restore" })}
                            style={{ padding: "6px 10px", fontSize: "11px", background: "#274029" }}
                          >
                            Restore Report ✓
                          </button>
                        ) : (
                          <button
                            className="button button-outline"
                            onClick={() => setItemModal({ item, action: "flag" })}
                            style={{ padding: "6px 10px", fontSize: "11px", borderColor: "#b12d2d", color: "#b12d2d" }}
                          >
                            Flag / Moderate ✕
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {/* Item Moderation Modal */}
              {itemModal && (
                <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !itemActionLoading) setItemModal(null); }}>
                  <section className="report-modal" style={{ maxWidth: "500px" }}>
                    <div className="modal-header">
                      <div>
                        <div className="section-kicker"><span /> MODERATION ACTION</div>
                        <h2>{itemModal.action.toUpperCase()} Item Report<span>.</span></h2>
                        <p>{itemModal.item.itemName} (Reported by #{itemModal.item.reportedBy})</p>
                      </div>
                      <button className="modal-close" onClick={() => setItemModal(null)} disabled={itemActionLoading}>×</button>
                    </div>

                    <div className="report-form" style={{ marginTop: "15px" }}>
                      <label>
                        Reason for moderation
                        <textarea
                          required
                          rows={3}
                          value={itemActionReason}
                          onChange={(e) => setItemActionReason(e.target.value)}
                          placeholder="Describe reason for flagging or restoring this item listing..."
                          style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", fontFamily: "inherit" }}
                        />
                      </label>

                      <div style={{ display: "flex", gap: "10px", marginTop: "15px" }}>
                        <button
                          className="button button-dark"
                          onClick={handleItemModerationSubmit}
                          disabled={itemActionLoading || !itemActionReason.trim()}
                          style={{ flex: 1, background: itemModal.action === "flag" ? "#b12d2d" : "#274029" }}
                        >
                          {itemActionLoading ? "Saving..." : `Confirm ${itemModal.action.toUpperCase()} ↗`}
                        </button>
                        <button className="button button-outline" onClick={() => setItemModal(null)} disabled={itemActionLoading}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </section>
          )}

          {/* =========================================================
              TAB 5: DISPUTED MATCHES (PRESERVED WORKFLOW)
             ========================================================= */}
          {activeTab === "disputes" && (
            <section className="profile-matches">
              <div className="section-heading">
                <div>
                  <div className="section-kicker"><span /> ACTION REQUIRED</div>
                  <h2>Disputed Ownership Claims<span>.</span></h2>
                  <p>Matches flagged by students requiring administrator review and item arbitration.</p>
                </div>
              </div>

              {disputes.length === 0 ? (
                <p className="profile-empty-note">No active disputes! All campus lost & found matches are clear.</p>
              ) : (
                <div className="match-list">
                  {disputes.map((match) => (
                    <article className="match-row" key={match._id} style={{ borderLeft: "5px solid #b12d2d" }}>
                      <div>
                        <span className="match-label">CLAIMANT (STUDENT #{match.lostReportedBy})</span>
                        <strong>{match.lostItem?.itemName || "Lost Report"}</strong>
                        <small>{match.lostItem?.color} · {match.lostItem?.location}</small>
                        {match.lostItem?.serialNumber && (
                          <small style={{ color: "#274029", fontWeight: "bold" }}>
                            Serial #: {match.lostItem.serialNumber}
                          </small>
                        )}
                        {match.lostItem?.identifyingMarks && (
                          <small style={{ color: "#777" }}>
                            Private Marks: {match.lostItem.identifyingMarks}
                          </small>
                        )}
                      </div>

                      <span className="match-connector">↔</span>

                      <div>
                        <span className="match-label">FINDER (STUDENT #{match.foundReportedBy})</span>
                        <strong>{match.foundItem?.itemName || "Found Report"}</strong>
                        <small>{match.foundItem?.color} · {match.foundItem?.location}</small>
                        {match.foundItem?.verificationQuestion && (
                          <small style={{ color: "#b18c38" }}>
                            Q: {match.foundItem.verificationQuestion}
                          </small>
                        )}
                      </div>

                      <div className="match-meta" style={{ minWidth: "160px" }}>
                        <span style={{ color: "#b12d2d" }}>DISPUTED</span>
                        <small style={{ fontStyle: "italic", maxWidth: "200px" }}>
                          &ldquo;{match.disputeReason || "No details provided"}&rdquo;
                        </small>
                        <button
                          className="button button-dark"
                          onClick={() => setSelectedDispute(match)}
                          style={{ marginTop: "8px" }}
                        >
                          Review & Arbitrate ↗
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {/* Dispute Resolution Modal */}
              {selectedDispute && (
                <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !disputeLoading) setSelectedDispute(null); }}>
                  <section className="report-modal" style={{ maxWidth: "650px", maxHeight: "90vh", overflowY: "auto" }}>
                    <div className="modal-header">
                      <div>
                        <div className="section-kicker"><span /> DISPUTE ARBITRATION</div>
                        <h2>Review Disputed Match<span>.</span></h2>
                        <p>Verify private marks and evidence before authorizing handover.</p>
                      </div>
                      <button className="modal-close" onClick={() => setSelectedDispute(null)} disabled={disputeLoading}>×</button>
                    </div>

                    <div style={{ background: "#fbfbf7", padding: "16px", borderRadius: "8px", margin: "15px 0" }}>
                      <p><strong>Lost Item:</strong> {selectedDispute.lostItem?.itemName} (Student #{selectedDispute.lostReportedBy})</p>
                      <p><strong>Found Item:</strong> {selectedDispute.foundItem?.itemName} (Student #{selectedDispute.foundReportedBy})</p>
                      {selectedDispute.lostItem?.serialNumber && (
                        <p><strong>Serial Number:</strong> <code>{selectedDispute.lostItem.serialNumber}</code></p>
                      )}
                      {selectedDispute.lostItem?.identifyingMarks && (
                        <p><strong>Private Identifying Marks:</strong> {selectedDispute.lostItem.identifyingMarks}</p>
                      )}
                      {selectedDispute.disputeReason && (
                        <p style={{ color: "#b12d2d" }}><strong>Dispute Notes:</strong> {selectedDispute.disputeReason}</p>
                      )}
                    </div>

                    <div className="report-form" style={{ marginTop: "15px" }}>
                      <label>
                        Handover Collection Desk
                        <input
                          value={disputeHandover}
                          onChange={(e) => setDisputeHandover(e.target.value)}
                          placeholder="e.g. Central Security Desk"
                        />
                      </label>

                      <label>
                        Arbitration Notes
                        <textarea
                          rows={3}
                          value={disputeNotes}
                          onChange={(e) => setDisputeNotes(e.target.value)}
                          placeholder="Verified student credentials and matching serial marks..."
                          style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #ccc", fontFamily: "inherit" }}
                        />
                      </label>

                      <div style={{ display: "flex", gap: "10px", marginTop: "15px" }}>
                        <button
                          className="button button-dark"
                          onClick={() => handleDisputeResolve("approve")}
                          disabled={disputeLoading}
                          style={{ background: "#274029", flex: 1 }}
                        >
                          {disputeLoading ? "Processing..." : "Approve Handover ✓"}
                        </button>
                        <button
                          className="button button-outline"
                          onClick={() => handleDisputeResolve("reject")}
                          disabled={disputeLoading}
                          style={{ borderColor: "#b12d2d", color: "#b12d2d", flex: 1 }}
                        >
                          {disputeLoading ? "Processing..." : "Reject Claim ✕"}
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </section>
          )}

          {/* =========================================================
              TAB 6: AUDIT TRAIL LOGS
             ========================================================= */}
          {activeTab === "audit" && (
            <section className="profile-reports">
              <div className="section-heading">
                <div>
                  <div className="section-kicker"><span /> COMPLIANCE & SECURITY</div>
                  <h2>Administrative Audit Logs<span>.</span></h2>
                  <p>Immutable record of administrative actions, account modifications, and claim approvals.</p>
                </div>
              </div>

              {auditLogs.length === 0 ? (
                <p className="profile-empty-note">No administrative audit records logged yet.</p>
              ) : (
                <div className="match-list">
                  {auditLogs.map((log) => (
                    <article className="match-row" key={log._id} style={{ alignItems: "center" }}>
                      <div>
                        <span className="match-label" style={{ color: "#274029" }}>ACTION: {log.action}</span>
                        <strong>{log.details || log.action}</strong>
                        <small style={{ color: "#777", display: "block" }}>
                          Admin: {log.adminName} (#{log.adminId}) · {new Date(log.createdAt).toLocaleString()}
                        </small>
                      </div>

                      <div style={{ minWidth: "180px" }}>
                        <span className="match-label">TARGET / REASON</span>
                        {log.targetUserId && <small style={{ display: "block" }}>User: #{log.targetUserId}</small>}
                        {log.targetClaimId && <small style={{ display: "block" }}>Claim: #{String(log.targetClaimId).slice(-6)}</small>}
                        {log.reason && (
                          <small style={{ color: "#555", fontStyle: "italic", display: "block" }}>
                            &ldquo;{log.reason}&rdquo;
                          </small>
                        )}
                      </div>

                      <div className="match-meta" style={{ minWidth: "120px" }}>
                        {log.previousStatus && log.newStatus ? (
                          <small style={{ fontWeight: "600" }}>
                            {log.previousStatus} → <span style={{ color: "#274029" }}>{log.newStatus}</span>
                          </small>
                        ) : (
                          <small style={{ color: "#888" }}>Recorded</small>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
