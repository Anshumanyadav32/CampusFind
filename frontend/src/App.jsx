
import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api").replace(/\/$/, "");
const API = `${API_BASE_URL}/items`;
const AUTH_API = `${API_BASE_URL}/auth`;
const PROFILE_API = `${API_BASE_URL}/profile`;
const PAGE_SIZE = 24;

axios.defaults.withCredentials = true;

const initialForm = {
  itemName: "",
  category: "Electronics",
  color: "",
  reportType: "lost",
  location: "",
  reportedBy: "",
};

const initialAuthForm = {
  studentId: "",
  name: "",
  email: "",
  password: "",
};

function App() {
  const [items, setItems] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [activePage, setActivePage] = useState("home");
  const [profileData, setProfileData] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", email: "" });
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authMethod, setAuthMethod] = useState("loading");
  const [authForm, setAuthForm] = useState(initialAuthForm);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeType, setNoticeType] = useState("success");

  const loadItems = useCallback(async () => {
    const params = { page, pageSize: PAGE_SIZE };
    if (activeTab !== "all") {
      params.reportType = activeTab;
    }
    if (category !== "all") {
      params.category = category;
    }
    if (debouncedSearch) {
      params.q = debouncedSearch;
    }

    const response = await axios.get(`${API}/search`, { params });
    return response.data;
  }, [activeTab, category, debouncedSearch, page]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadItems();
      setItems(data.items);
      setTotalItems(data.total);
      setTotalPages(data.totalPages);
      setError("");
    } catch (err) {
      setError(
        err.response?.data?.message ||
          "Could not load items. Check that your backend is running."
      );
    } finally {
      setLoading(false);
    }
  }, [loadItems]);

  async function fetchProfile() {
    setProfileLoading(true);
    try {
      const [profileResponse, matchResponse] = await Promise.all([
        axios.get(PROFILE_API),
        axios.get(`${API}/matches`)
      ]);
      setProfileData({
        ...profileResponse.data,
        matches: matchResponse.data.matches
      });
      setProfileForm({
        name: profileResponse.data.user.name || "",
        email: profileResponse.data.user.email || "",
      });
    } catch (err) {
      setNoticeType("error");
      setNotice(err.response?.data?.message || "Could not load your profile.");
    } finally {
      setProfileLoading(false);
    }
  }

  async function openProfile() {
    if (!currentUser) {
      setShowAuth(true);
      return;
    }

    setActivePage("profile");
    await fetchProfile();
  }

  async function saveProfile(event) {
    event.preventDefault();
    setProfileSaving(true);
    try {
      const response = await axios.patch(PROFILE_API, profileForm);
      setCurrentUser(response.data.user);
      setProfileData((previous) => ({
        ...previous,
        user: { ...previous.user, ...response.data.user },
      }));
      setNoticeType("success");
      setNotice(response.data.message);
    } catch (err) {
      setNoticeType("error");
      setNotice(err.response?.data?.message || "Could not save your profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  async function confirmMatch(match) {
    const confirming = match.status === "confirming";
    const question = confirming
      ? "Resume marking these reports as returned?"
      : "Confirm that the lost item was returned to you?";
    if (!window.confirm(question)) return;

    try {
      const response = await axios.patch(`${API}/matches/${match._id}/confirm`);
      setNoticeType("success");
      setNotice(response.data.message);
      await fetchProfile();
    } catch (err) {
      setNoticeType("error");
      setNotice(err.response?.data?.message || "Could not confirm this match.");
      await fetchProfile();
    }
  }

  useEffect(() => {
    let cancelled = false;
    axios.get(`${AUTH_API}/method`)
      .then((response) => {
        if (!cancelled) setAuthMethod(response.data.mode);
      })
      .catch(() => {
        if (!cancelled) setAuthMethod("unavailable");
      });

    axios.get(`${AUTH_API}/current-user`)
      .then((response) => {
        if (cancelled) return;
        setCurrentUser(response.data.user);
        setForm((previous) => ({
          ...previous,
          reportedBy: String(response.data.user.studentId),
        }));
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    loadItems()
      .then((data) => {
        if (!cancelled) {
          setItems(data.items);
          setTotalItems(data.total);
          setTotalPages(data.totalPages);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err.response?.data?.message ||
              "Could not load items. Check that your backend is running."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadItems]);

  const filteredItems = items;

  const lostCount = items.filter(
    (item) => item.reportType === "lost"
  ).length;

  const foundCount = items.filter(
    (item) => item.reportType === "found"
  ).length;

  function updateForm(event) {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
  }

  function updateAuthForm(event) {
    const { name, value } = event.target;
    setAuthForm((previous) => ({ ...previous, [name]: value }));
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthSubmitting(true);
    setNotice("");

    try {
      const endpoint = authMode === "login" ? "/login" : "/register";
      const payload =
        authMode === "login"
          ? {
              studentId: Number(authForm.studentId),
              password: authForm.password,
            }
          : {
              studentId: Number(authForm.studentId),
              name: authForm.name,
              email: authForm.email,
              password: authForm.password,
            };

      const response = await axios.post(`${AUTH_API}${endpoint}`, payload);
      setCurrentUser(response.data.user);
      setForm((previous) => ({
        ...previous,
        reportedBy: String(response.data.user.studentId),
      }));
      setAuthForm(initialAuthForm);
      setShowAuth(false);
      setNoticeType("success");
      setNotice(
        authMode === "login"
          ? "Signed in successfully."
          : "Account created successfully."
      );
    } catch (err) {
      setNoticeType("error");
      setNotice(
        err.response?.data?.message ||
          "Could not complete this request. Please try again."
      );
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    try {
      await axios.post(`${AUTH_API}/logout`);
      setCurrentUser(null);
      setActivePage("home");
      setProfileData(null);
      setForm((previous) => ({ ...previous, reportedBy: "" }));
      setNoticeType("success");
      setNotice("Signed out successfully.");
    } catch {
      setNoticeType("error");
      setNotice("Could not sign out right now.");
    }
  }

  async function submitReport(event) {
    event.preventDefault();
    setSubmitting(true);
    setNotice("");

    if (!currentUser) {
      setNoticeType("error");
      setNotice("Please sign in before reporting an item.");
      setShowAuth(true);
      setSubmitting(false);
      return;
    }

    try {
      const studentId = currentUser.studentId;
      const response = await axios.post(API, {
        ...form,
        reportedBy: studentId,
      });

      setNoticeType("success");
      setNotice(`Item reported successfully. ${response.data.matchMessage}`);
      setForm({ ...initialForm, reportedBy: String(studentId) });
      setShowForm(false);

      if (page === 1) {
        await fetchItems();
      } else {
        setLoading(true);
        setPage(1);
      }
      if (activePage === "profile") {
        await fetchProfile();
      }
    } catch (err) {
      setNoticeType("error");
      setNotice(
        err.response?.data?.message ||
          "Could not submit the report. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  function openReport(type) {
    if (!currentUser) {
      setShowAuth(true);
      setNoticeType("error");
      setNotice("Sign in to report an item.");
      return;
    }

    setForm({ ...initialForm, reportType: type, reportedBy: String(currentUser.studentId) });
    setNotice("");
    setShowForm(true);
  }

  function getItemIcon(item) {
    const categoryName = String(item.category || "").toLowerCase();
    const name = String(item.itemName || "").toLowerCase();

    if (categoryName.includes("electronic")) return "⌁";
    if (categoryName.includes("document")) return "▤";
    if (categoryName.includes("bottle") || name.includes("bottle")) return "♧";
    if (categoryName.includes("accessor")) return "✳";
    if (name.includes("wallet")) return "▰";
    if (name.includes("key")) return "⚿";

    return "✦";
  }

  return (
    <div className="campus-app">
      <nav className="navbar">
        <a className="brand" href="#home">
          <span className="brand-icon">C<span>.</span></span>
          <span>campus<span className="brand-light">find</span></span>
        </a>

        <div className="nav-links">
          <button onClick={() => setActivePage("home")}>Home</button>
          {activePage === "home" && (
            <>
              <a href="#items">Explore items</a>
              <a href="#how-it-works">How it works</a>
            </>
          )}
        </div>

        <div className="nav-actions">
          {currentUser ? (
            <>
              <button className="button button-outline" onClick={openProfile}>
                My profile
              </button>
              <span className="user-pill">Hi, {currentUser.name || `#${currentUser.studentId}`}</span>
              <button className="button button-outline" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <button className="button button-outline" onClick={() => setShowAuth(true)}>
              Sign in
            </button>
          )}

          <button className="nav-cta" onClick={() => openReport("lost")}>
            Report an item <span>↗</span>
          </button>
        </div>
      </nav>

      {notice && (
        <div className={`notice ${noticeType}`} role="status">
          <span>{noticeType === "success" ? "✓" : "!"}</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}

      {activePage === "profile" ? (
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
            <div className="state-panel"><div className="loader" /><p>Loading your profile...</p></div>
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
                      <p>Student ID · {profileData.user.studentId}</p>
                    </div>
                  </div>

                  <form className="profile-form" onSubmit={saveProfile}>
                    <label>
                      Full name
                      <input
                        value={profileForm.name}
                        onChange={(event) => setProfileForm((previous) => ({ ...previous, name: event.target.value }))}
                        maxLength={100}
                        required
                      />
                    </label>
                    <label>
                      Email address
                      <input
                        type="email"
                        value={profileForm.email}
                        onChange={(event) => setProfileForm((previous) => ({ ...previous, email: event.target.value }))}
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
                    <span>{profileData.reports.filter((item) => item.reportType === "lost").length} lost</span>
                    <span>{profileData.reports.filter((item) => item.reportType === "found").length} found</span>
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
                  <p className="profile-empty-note">New possible matches for your reports will show up here.</p>
                ) : (
                  <div className="match-list">
                    {profileData.matches.map((match) => (
                      <article className="match-row" key={match._id}>
                        <div>
                          <span className="match-label">LOST REPORT</span>
                          <strong>{match.lostItem?.itemName || "Report unavailable"}</strong>
                          <small>{match.lostItem?.color} · {match.lostItem?.location}</small>
                        </div>
                        <span className="match-connector">↔</span>
                        <div>
                          <span className="match-label">FOUND REPORT</span>
                          <strong>{match.foundItem?.itemName || "Report unavailable"}</strong>
                          <small>{match.foundItem?.color} · {match.foundItem?.location}</small>
                        </div>
                        <div className="match-meta">
                          <span>{match.matchScore}% match</span>
                          <small>{match.status === "confirmed" ? "Returned" : match.status}</small>
                          {match.lostReportedBy === currentUser.studentId
                            && ["pending", "confirming"].includes(match.status) && (
                              <button
                                className="button button-dark"
                                onClick={() => confirmMatch(match)}
                              >
                                {match.status === "confirming" ? "Resume confirmation" : "Confirm returned"}
                              </button>
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
                    <h2>My reports<span>.</span></h2>
                  </div>
                  <button className="button button-dark" onClick={() => openReport("lost")}>
                    Report an item <span>↗</span>
                  </button>
                </div>

                {profileData.reports.length === 0 ? (
                  <div className="state-panel empty-panel">
                    <span className="state-emoji">✳</span>
                    <h3>No reports yet.</h3>
                    <p>Your lost and found reports will appear here.</p>
                  </div>
                ) : (
                  <div className="items-grid">
                    {profileData.reports.map((item, index) => (
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
                                ? new Date(item.dateReported).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                                : ""}
                            </span>
                          </div>
                          <h3>{item.itemName}</h3>
                          <div className="item-detail"><span>◉</span> {item.color}</div>
                          <div className="item-detail"><span>⌖</span> {item.location}</div>
                          <div className="item-card-footer">
                            <span className="item-status-text">
                              {item.status === "returned" ? "✓ Returned" : item.reportType === "lost" ? "Still looking" : "Waiting for owner"}
                            </span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="state-panel">
              <span className="state-emoji">⚠</span>
              <h3>We couldn't load your profile.</h3>
              <button className="button button-dark" onClick={openProfile}>Try again ↻</button>
            </div>
          )}
        </main>
      ) : (
      <main>
        <section className="hero" id="home">
          <div className="hero-orb orb-one" />
          <div className="hero-orb orb-two" />

          <div className="hero-content">
            <div className="hero-label">
              <span className="label-dot" />
              THE CAMPUS COMMUNITY BOARD
            </div>

            <h1>
              Lost it?
              <br />
              <span>Let's get it</span>
              <br />
              <span className="highlight-word">back.</span>
            </h1>

            <p className="hero-description">
              Lost your wallet between classes? Found someone's keys?
              Little things matter. Let's help them find their way home.
            </p>

            <div className="hero-actions">
              <button
                className="button button-dark"
                onClick={() => openReport("lost")}
              >
                I lost something <span>↗</span>
              </button>

              <button
                className="button button-outline"
                onClick={() => openReport("found")}
              >
                I found something <span>✳</span>
              </button>
            </div>

            <div className="hero-social-proof">
              <div className="avatar-stack">
                <span>R</span><span>P</span><span>A</span><span>N</span>
              </div>
              <p><strong>Your campus.</strong> Everyone looking out for everyone.</p>
            </div>
          </div>

          <div className="hero-art" aria-label="CampusFind community illustration">
            <div className="art-spark spark-a">✳</div>
            <div className="art-spark spark-b">✦</div>

            <div className="art-card card-back">
              <span className="art-card-label">GOOD THINGS HAPPEN</span>
              <div className="art-smile">☺</div>
            </div>

            <div className="art-card card-front">
              <div className="art-card-top">
                <span>FOUND SOMETHING?</span>
                <span className="art-live"><i /> LIVE</span>
              </div>
              <div className="art-wallet">▰</div>
              <div className="art-item-title">Black wallet</div>
              <div className="art-item-location">⌖ &nbsp; Library · Today</div>
              <div className="art-card-bottom">
                <span className="art-tag">READY TO RETURN</span>
                <span className="art-arrow">↗</span>
              </div>
            </div>

            <div className="floating-note note-top">
              <span className="note-emoji">✳</span>
              <span><strong>Good karma</strong><small>Starts right here</small></span>
            </div>

            <div className="floating-note note-bottom">
              <span className="note-check">✓</span>
              <span><strong>One less worry</strong><small>That's the goal.</small></span>
            </div>
          </div>

          <div className="hero-bottom">
            <span>MADE FOR CAMPUS LIFE</span>
            <span className="hero-bottom-line" />
            <a href="#items">Scroll to explore ↓</a>
          </div>
        </section>

        <section className="stats-strip" aria-label="Community statistics">
          <div className="stat-block">
            <span className="stat-icon stat-yellow">⌕</span>
            <div><strong>{totalItems}</strong><span>Reports matching filters</span></div>
          </div>
          <div className="stat-block">
            <span className="stat-icon stat-purple">↗</span>
            <div><strong>{lostCount}</strong><span>Lost on this page</span></div>
          </div>
          <div className="stat-block">
            <span className="stat-icon stat-green">✓</span>
            <div><strong>{foundCount}</strong><span>Found on this page</span></div>
          </div>
          <div className="stat-message">
            Small acts. <span>Big impact.</span>
          </div>
        </section>

        <section className="items-section" id="items">
          <div className="section-heading">
            <div>
              <div className="section-kicker"><span /> THE COMMUNITY BOARD</div>
              <h2>Things looking<br />for their people<span>.</span></h2>
              <p>Browse the board. You never know what you'll find.</p>
            </div>
            <button className="button button-dark desktop-report" onClick={() => openReport("found")}>
              Post a found item <span>↗</span>
            </button>
          </div>

          <div className="filters-panel">
            <div className="filter-tabs">
              {[
                { value: "all", label: "Everything" },
                { value: "lost", label: "✕ Lost" },
                { value: "found", label: "✓ Found" },
              ].map((tab) => (
                <button
                  key={tab.value}
                  className={activeTab === tab.value ? "filter-tab selected" : "filter-tab"}
                  onClick={() => {
                    setLoading(true);
                    setPage(1);
                    setActiveTab(tab.value);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="filter-controls">
              <label className="search-box">
                <span>⌕</span>
                <input
                  type="search"
                  placeholder="Search name, color, location..."
                  value={search}
                  onChange={(event) => {
                    setLoading(true);
                    setSearch(event.target.value);
                  }}
                />
                {search && (
                  <button
                    onClick={() => {
                      setLoading(true);
                      setSearch("");
                    }}
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}
              </label>

              <select
                className="category-select"
                value={category}
                onChange={(event) => {
                  setLoading(true);
                  setPage(1);
                  setCategory(event.target.value);
                }}
                aria-label="Filter by category"
              >
                <option value="all">All categories</option>
                <option value="Electronics">Electronics</option>
                <option value="Accessories">Accessories</option>
                <option value="Documents">Documents</option>
                <option value="Bottle">Bottle</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="state-panel"><div className="loader" /><p>Finding your items...</p></div>
          ) : error ? (
            <div className="state-panel">
              <span className="state-emoji">⚠</span>
              <h3>We couldn't load the board.</h3>
              <p>{error}</p>
              <button className="button button-dark" onClick={fetchItems}>Try again ↻</button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="state-panel empty-panel">
              <span className="state-emoji">✳</span>
              <h3>No matches just yet.</h3>
              <p>Try another search or be the first to report an item.</p>
              <button className="button button-dark" onClick={() => openReport(activeTab === "found" ? "found" : "lost")}>
                Report an item ↗
              </button>
            </div>
          ) : (
            <div className="items-grid">
              {filteredItems.map((item, index) => (
                <article className="item-card" key={item._id} style={{ "--card-index": index }}>
                  <div className={`item-visual visual-${index % 5}`}>
                    <span className="visual-decoration decoration-one">✳</span>
                    <span className="item-symbol">{getItemIcon(item)}</span>
                    <span className={`status-pill ${item.reportType}`}>
                      <span /> {item.reportType === "lost" ? "LOST ITEM" : "FOUND ITEM"}
                    </span>
                    <span className="visual-number">{String(index + 1).padStart(2, "0")}</span>
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
                    <div className="item-detail"><span>◉</span> {item.color}</div>
                    <div className="item-detail"><span>⌖</span> {item.location}</div>

                    <div className="item-card-footer">
                      <span className="item-status-text">
                        {item.status === "returned" ? "✓ Returned" : item.reportType === "lost" ? "Still looking" : "Waiting for owner"}
                      </span>
                      <span className="item-card-arrow">↗</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {!loading && !error && filteredItems.length > 0 && (
            <div className="board-footer">
              <span>
                SHOWING {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalItems)} OF {totalItems} ITEMS
              </span>
              <span>Good things happen when we look out for each other ✳</span>
            </div>
          )}

          {!loading && !error && totalPages > 1 && (
            <div className="pagination-controls" aria-label="Item report pages">
              <button
                className="button button-outline"
                disabled={page <= 1}
                onClick={() => {
                  setLoading(true);
                  setPage((current) => current - 1);
                }}
              >
                Previous
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                className="button button-outline"
                disabled={page >= totalPages}
                onClick={() => {
                  setLoading(true);
                  setPage((current) => current + 1);
                }}
              >
                Next
              </button>
            </div>
          )}
        </section>

        <section className="how-section" id="how-it-works">
          <div className="how-intro">
            <div className="section-kicker light-kicker"><span /> EASY AS 1, 2, 3</div>
            <h2>Lost things.<br />Found people.</h2>
            <p>Getting your stuff back shouldn't be complicated.</p>
          </div>

          <div className="how-steps">
            <article className="how-step">
              <span className="step-number">01</span>
              <div className="step-icon step-yellow">＋</div>
              <h3>Post it</h3>
              <p>Report something you've lost or found in just a few clicks.</p>
            </article>
            <article className="how-step">
              <span className="step-number">02</span>
              <div className="step-icon step-purple">⌕</div>
              <h3>Find it</h3>
              <p>Search reports by item, color, category, or campus location.</p>
            </article>
            <article className="how-step">
              <span className="step-number">03</span>
              <div className="step-icon step-green">♡</div>
              <h3>Return it</h3>
              <p>Help belongings find their owners and make someone's day.</p>
            </article>
          </div>
        </section>

        <section className="bottom-cta">
          <div>
            <span className="cta-spark">✳</span>
            <h2>Be someone's<br /><span>good news today.</span></h2>
            <p>It takes a campus to bring things home.</p>
          </div>
          <div className="cta-actions">
            <button className="button button-dark" onClick={() => openReport("lost")}>I lost something ↗</button>
            <button className="button button-outline" onClick={() => openReport("found")}>I found something ✳</button>
          </div>
        </section>
      </main>
      )}

      <footer className="footer">
        <a className="brand footer-brand" href="#home">
          <span className="brand-icon">C<span>.</span></span>
          <span>campus<span className="brand-light">find</span></span>
        </a>
        <p>Made with care for the campus community.</p>
        <a href="#home">Back to top ↑</a>
      </footer>

      {showForm && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) {
              setShowForm(false);
            }
          }}
        >
          <section className="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <div className="modal-header">
              <div>
                <div className="section-kicker"><span /> COMMUNITY REPORT</div>
                <h2 id="report-title">Let's bring it <span>home.</span></h2>
                <p>Tell us a little about the item.</p>
              </div>
              <button
                className="modal-close"
                onClick={() => setShowForm(false)}
                disabled={submitting}
                aria-label="Close form"
              >
                ×
              </button>
            </div>

            <div className="report-type-picker">
              <button
                type="button"
                className={form.reportType === "lost" ? "type-option chosen lost-choice" : "type-option"}
                onClick={() => setForm({ ...form, reportType: "lost" })}
              >
                <span>⌕</span><strong>I've lost it</strong><small>Help me find it</small>
              </button>
              <button
                type="button"
                className={form.reportType === "found" ? "type-option chosen found-choice" : "type-option"}
                onClick={() => setForm({ ...form, reportType: "found" })}
              >
                <span>✳</span><strong>I've found it</strong><small>Help it get home</small>
              </button>
            </div>

            <form onSubmit={submitReport} className="report-form">
              <label>
                Item name
                <input
                  name="itemName"
                  value={form.itemName}
                  onChange={updateForm}
                  placeholder="e.g. Blue water bottle"
                  required
                  maxLength={100}
                />
              </label>

              <div className="form-row">
                <label>
                  Category
                  <select name="category" value={form.category} onChange={updateForm} required>
                    <option>Electronics</option>
                    <option>Accessories</option>
                    <option>Documents</option>
                    <option>Bottle</option>
                    <option>Clothing</option>
                    <option>Other</option>
                  </select>
                </label>
                <label>
                  Color
                  <input
                    name="color"
                    value={form.color}
                    onChange={updateForm}
                    placeholder="e.g. Blue"
                    required
                    maxLength={50}
                  />
                </label>
              </div>

              <label>
                Where was it lost or found?
                <input
                  name="location"
                  value={form.location}
                  onChange={updateForm}
                  placeholder="e.g. Library, Block 32"
                  required
                  maxLength={150}
                />
              </label>

              <label>
                Reporter
                <input
                  name="reportedBy"
                  type="number"
                  min="1"
                  value={form.reportedBy}
                  onChange={updateForm}
                  required
                  readOnly={Boolean(currentUser)}
                />
                <small className="field-hint">
                  {currentUser
                    ? `Signed in as ${currentUser.name || "student"} (${currentUser.studentId})`
                    : "Sign in to report an item with your campus account."}
                </small>
              </label>

              <button className="button button-dark submit-button" disabled={submitting}>
                {submitting ? "Submitting report..." : "Submit report"} <span>↗</span>
              </button>
              <p className="privacy-note">Please don't include passwords or sensitive personal information.</p>
            </form>
          </section>
        </div>
      )}

      {showAuth && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !authSubmitting) {
              setShowAuth(false);
            }
          }}
        >
          <section className="report-modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <div className="modal-header">
              <div>
                <div className="section-kicker"><span /> ACCOUNT ACCESS</div>
                <h2 id="auth-title">
                  {authMethod === "oidc"
                    ? "Campus sign-in."
                    : authMode === "login"
                      ? "Welcome back."
                      : "Create your account."}
                </h2>
                <p>
                  {authMethod === "oidc"
                    ? "Use your institution's single sign-on account."
                    : authMode === "login"
                      ? "Sign in to report items and manage your campus matches."
                      : "Register to join the campus board."}
                </p>
              </div>
              <button
                className="modal-close"
                onClick={() => setShowAuth(false)}
                disabled={authSubmitting}
                aria-label="Close signup form"
              >
                ×
              </button>
            </div>

            {authMethod === "oidc" ? (
              <div className="report-form">
                <button
                  type="button"
                  className="button button-dark submit-button"
                  onClick={() => window.location.assign(`${AUTH_API}/sso`)}
                >
                  Continue with campus SSO <span>↗</span>
                </button>
                <p className="privacy-note">
                  Your institution verifies your identity. CampusFind does not receive your SSO password.
                </p>
              </div>
            ) : authMethod === "local" ? (
            <>
            <div className="report-type-picker auth-switcher">
              <button
                type="button"
                className={authMode === "login" ? "type-option chosen" : "type-option"}
                onClick={() => setAuthMode("login")}
              >
                <span>✓</span><strong>Log in</strong><small>Already a member</small>
              </button>
              <button
                type="button"
                className={authMode === "register" ? "type-option chosen" : "type-option"}
                onClick={() => setAuthMode("register")}
              >
                <span>✳</span><strong>Register</strong><small>Join the board</small>
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="report-form">
              {authMode === "register" && (
                <label>
                  Full name
                  <input
                    name="name"
                    value={authForm.name}
                    onChange={updateAuthForm}
                    placeholder="e.g. Priya Sharma"
                    required
                  />
                </label>
              )}

              <label>
                Student ID
                <input
                  name="studentId"
                  type="number"
                  min="1"
                  value={authForm.studentId}
                  onChange={updateAuthForm}
                  placeholder="e.g. 101"
                  required
                />
              </label>

              {authMode === "register" && (
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    value={authForm.email}
                    onChange={updateAuthForm}
                    placeholder="you@campus.edu"
                    required
                  />
                </label>
              )}

              <label>
                Password
                <input
                  name="password"
                  type="password"
                  value={authForm.password}
                  onChange={updateAuthForm}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                />
              </label>

              <button className="button button-dark submit-button" disabled={authSubmitting}>
                {authSubmitting
                  ? authMode === "login"
                    ? "Signing in..."
                    : "Creating account..."
                  : authMode === "login"
                    ? "Sign in"
                    : "Create account"}
                <span>↗</span>
              </button>

              <p className="privacy-note">
                {authMode === "login"
                  ? "Need an account? Use the register tab to join the board."
                  : "Already registered? Switch to log in."}
              </p>
            </form>
            </>
            ) : (
              <p className="privacy-note">
                Sign-in options are unavailable. Confirm the backend is running and try again.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;





















// import { useEffect, useState } from "react";
// import axios from "axios";
// import "./App.css";

// const API = "http://localhost:5000/api/items";

// const initialForm = {
//   itemName: "",
//   category: "Electronics",
//   color: "",
//   reportType: "lost",
//   location: "",
//   reportedBy: "101",
// };

// function App() {
//   const [items, setItems] = useState([]);
//   const [matches, setMatches] = useState([]);

//   const [activeTab, setActiveTab] = useState("all");
//   const [search, setSearch] = useState("");
//   const [category, setCategory] = useState("all");

//   const [currentUserId, setCurrentUserId] = useState("101");

//   const [loading, setLoading] = useState(true);
//   const [matchLoading, setMatchLoading] = useState(true);
//   const [submitting, setSubmitting] = useState(false);
//   const [confirmingId, setConfirmingId] = useState("");

//   const [error, setError] = useState("");
//   const [matchError, setMatchError] = useState("");

//   const [showForm, setShowForm] = useState(false);
//   const [form, setForm] = useState(initialForm);

//   const [notice, setNotice] = useState("");
//   const [noticeType, setNoticeType] = useState("success");

//   // Fetch all items so that statistics remain correct on every tab.
//   async function fetchItems() {
//     setLoading(true);
//     setError("");

//     try {
//       const response = await axios.get(`${API}/search`);
//       setItems(Array.isArray(response.data) ? response.data : []);
//     } catch (err) {
//       setError(
//         err.response?.data?.message ||
//           "Could not load items. Check that your backend is running."
//       );
//     } finally {
//       setLoading(false);
//     }
//   }

//   // Fetch matches belonging to the selected demo user.
//   async function fetchMatches(userId = currentUserId) {
//     if (!userId) return;

//     setMatchLoading(true);
//     setMatchError("");

//     try {
//       const response = await axios.get(`${API}/matches`, {
//         params: { reportedBy: Number(userId) },
//       });

//       setMatches(response.data.matches || []);
//     } catch (err) {
//       setMatchError(
//         err.response?.data?.message ||
//           "Could not load potential matches."
//       );
//       setMatches([]);
//     } finally {
//       setMatchLoading(false);
//     }
//   }

//   useEffect(() => {
//     fetchItems();
//   }, []);

//   useEffect(() => {
//     fetchMatches(currentUserId);
//   }, [currentUserId]);

//   // Filter items on the frontend.
//   const filteredItems = items.filter((item) => {
//     const matchesTab =
//       activeTab === "all" || item.reportType === activeTab;

//     const searchText = search.toLowerCase().trim();

//     const matchesSearch = [
//       item.itemName,
//       item.category,
//       item.color,
//       item.location,
//     ].some((value) =>
//       String(value || "").toLowerCase().includes(searchText)
//     );

//     const matchesCategory =
//       category === "all" ||
//       String(item.category || "").toLowerCase() ===
//         category.toLowerCase();

//     return matchesTab && matchesSearch && matchesCategory;
//   });

//   const lostCount = items.filter(
//     (item) => item.reportType === "lost"
//   ).length;

//   const foundCount = items.filter(
//     (item) => item.reportType === "found"
//   ).length;

//   const returnedCount = items.filter(
//     (item) => item.status === "returned"
//   ).length;

//   function showNotice(message, type = "success") {
//     setNotice(message);
//     setNoticeType(type);
//   }

//   function updateForm(event) {
//     const { name, value } = event.target;
//     setForm((previous) => ({
//       ...previous,
//       [name]: value,
//     }));
//   }

//   async function submitReport(event) {
//     event.preventDefault();

//     const cleanForm = {
//       ...form,
//       itemName: form.itemName.trim(),
//       color: form.color.trim(),
//       location: form.location.trim(),
//       reportedBy: Number(form.reportedBy),
//     };

//     if (
//       !cleanForm.itemName ||
//       !cleanForm.color ||
//       !cleanForm.location ||
//       !cleanForm.reportedBy
//     ) {
//       showNotice("Please fill in all fields correctly.", "error");
//       return;
//     }

//     setSubmitting(true);
//     setNotice("");

//     try {
//       const response = await axios.post(API, cleanForm);

//       // Set the selected user to the reporter of this item.
//       setCurrentUserId(String(cleanForm.reportedBy));

//       const message =
//         response.data.matchMessage ||
//         response.data.message ||
//         "Item reported successfully!";

//       showNotice(message, "success");

//       setForm({
//         ...initialForm,
//         reportedBy: String(cleanForm.reportedBy),
//       });

//       setShowForm(false);

//       await fetchItems();
//       await fetchMatches(String(cleanForm.reportedBy));
//     } catch (err) {
//       showNotice(
//         err.response?.data?.message ||
//           "Could not submit the report. Please try again.",
//         "error"
//       );
//     } finally {
//       setSubmitting(false);
//     }
//   }

//   function openReport(type) {
//     setForm({
//       ...initialForm,
//       reportType: type,
//       reportedBy: currentUserId,
//     });

//     setNotice("");
//     setShowForm(true);
//   }

//   // Only the lost-item reporter can confirm a match.
//   async function confirmMatch(matchId) {
//     const confirmed = window.confirm(
//       "Have you verified that this is your lost item? Confirming will mark both reports as returned."
//     );

//     if (!confirmed) return;

//     setConfirmingId(matchId);

//     try {
//       const response = await axios.patch(
//         `${API}/matches/${matchId}/confirm`,
//         { userId: Number(currentUserId) }
//       );

//       showNotice(
//         response.data.message || "Item marked as returned!",
//         "success"
//       );

//       await fetchItems();
//       await fetchMatches();
//     } catch (err) {
//       showNotice(
//         err.response?.data?.message ||
//           "Could not confirm this match. Please try again.",
//         "error"
//       );
//     } finally {
//       setConfirmingId("");
//     }
//   }

//   function getItemIcon(item) {
//     const categoryName = String(item.category || "").toLowerCase();
//     const name = String(item.itemName || "").toLowerCase();

//     if (categoryName.includes("electronic")) return "⌁";
//     if (categoryName.includes("document")) return "▤";
//     if (categoryName.includes("bottle") || name.includes("bottle")) return "♧";
//     if (categoryName.includes("accessor")) return "✳";
//     if (name.includes("wallet")) return "▰";
//     if (name.includes("key")) return "⚿";

//     return "✦";
//   }

//   function formatDate(date) {
//     if (!date) return "";

//     return new Date(date).toLocaleDateString("en-IN", {
//       day: "numeric",
//       month: "short",
//       year: "numeric",
//     });
//   }

//   function renderMatchItem(label, item) {
//     if (!item) {
//       return (
//         <div className="match-item">
//           <div className="match-item-label">{label}</div>
//           <p>Item details are unavailable.</p>
//         </div>
//       );
//     }

//     return (
//       <div className="match-item">
//         <div className="match-item-label">{label}</div>
//         <h3>{item.itemName || "Unnamed item"}</h3>
//         <p><strong>Category:</strong> {item.category || "N/A"}</p>
//         <p><strong>Color:</strong> {item.color || "N/A"}</p>
//         <p><strong>Location:</strong> {item.location || "N/A"}</p>
//       </div>
//     );
//   }

//   return (
//     <div className="campus-app">
//       <nav className="navbar">
//         <a className="brand" href="#home">
//           <span className="brand-icon">C<span>.</span></span>
//           <span>campus<span className="brand-light">find</span></span>
//         </a>

//         <div className="nav-links">
//           <a href="#home">Home</a>
//           <a href="#items">Explore items</a>
//           <a href="#matches">Potential matches</a>
//           <a href="#how-it-works">How it works</a>
//         </div>

//         <button className="nav-cta" onClick={() => openReport("lost")}>
//           Report an item <span>↗</span>
//         </button>
//       </nav>

//       {notice && (
//         <div className={`notice ${noticeType}`} role="status">
//           <span>{noticeType === "success" ? "✓" : "!"}</span>
//           {notice}
//           <button
//             onClick={() => setNotice("")}
//             aria-label="Dismiss message"
//           >
//             ×
//           </button>
//         </div>
//       )}

//       <main>
//         {/* HERO */}
//         <section className="hero" id="home">
//           <div className="hero-orb orb-one" />
//           <div className="hero-orb orb-two" />

//           <div className="hero-content">
//             <div className="hero-label">
//               <span className="label-dot" />
//               THE CAMPUS COMMUNITY BOARD
//             </div>

//             <h1>
//               Lost it?
//               <br />
//               <span>Let's get it</span>
//               <br />
//               <span className="highlight-word">back.</span>
//             </h1>

//             <p className="hero-description">
//               Lost your wallet between classes? Found someone's keys?
//               Little things matter. Let's help them find their way home.
//             </p>

//             <div className="hero-actions">
//               <button
//                 className="button button-dark"
//                 onClick={() => openReport("lost")}
//               >
//                 I lost something <span>↗</span>
//               </button>

//               <button
//                 className="button button-outline"
//                 onClick={() => openReport("found")}
//               >
//                 I found something <span>✳</span>
//               </button>
//             </div>

//             <div className="hero-social-proof">
//               <div className="avatar-stack">
//                 <span>R</span>
//                 <span>P</span>
//                 <span>A</span>
//                 <span>N</span>
//               </div>
//               <p>
//                 <strong>Your campus.</strong> Everyone looking out for everyone.
//               </p>
//             </div>
//           </div>

//           <div className="hero-art" aria-label="CampusFind community illustration">
//             <div className="art-spark spark-a">✳</div>
//             <div className="art-spark spark-b">✦</div>

//             <div className="art-card card-back">
//               <span className="art-card-label">GOOD THINGS HAPPEN</span>
//               <div className="art-smile">☺</div>
//             </div>

//             <div className="art-card card-front">
//               <div className="art-card-top">
//                 <span>FOUND SOMETHING?</span>
//                 <span className="art-live"><i /> LIVE</span>
//               </div>
//               <div className="art-wallet">▰</div>
//               <div className="art-item-title">Black wallet</div>
//               <div className="art-item-location">⌖ &nbsp; Library · Today</div>
//               <div className="art-card-bottom">
//                 <span className="art-tag">READY TO RETURN</span>
//                 <span className="art-arrow">↗</span>
//               </div>
//             </div>

//             <div className="floating-note note-top">
//               <span className="note-emoji">✳</span>
//               <span>
//                 <strong>Good karma</strong>
//                 <small>Starts right here</small>
//               </span>
//             </div>

//             <div className="floating-note note-bottom">
//               <span className="note-check">✓</span>
//               <span>
//                 <strong>One less worry</strong>
//                 <small>That's the goal.</small>
//               </span>
//             </div>
//           </div>

//           <div className="hero-bottom">
//             <span>MADE FOR CAMPUS LIFE</span>
//             <span className="hero-bottom-line" />
//             <a href="#items">Scroll to explore ↓</a>
//           </div>
//         </section>

//         {/* STATISTICS */}
//         <section className="stats-strip" aria-label="Community statistics">
//           <div className="stat-block">
//             <span className="stat-icon stat-yellow">⌕</span>
//             <div>
//               <strong>{items.length}</strong>
//               <span>Community reports</span>
//             </div>
//           </div>

//           <div className="stat-block">
//             <span className="stat-icon stat-purple">↗</span>
//             <div>
//               <strong>{lostCount}</strong>
//               <span>Items lost</span>
//             </div>
//           </div>

//           <div className="stat-block">
//             <span className="stat-icon stat-green">✓</span>
//             <div>
//               <strong>{foundCount}</strong>
//               <span>Items found</span>
//             </div>
//           </div>

//           <div className="stat-block">
//             <span className="stat-icon stat-pink">♡</span>
//             <div>
//               <strong>{returnedCount}</strong>
//               <span>Items returned</span>
//             </div>
//           </div>

//           <div className="stat-message">
//             Small acts. <span>Big impact.</span>
//           </div>
//         </section>

//         {/* SMART MATCHING */}
//         <section className="matches-section" id="matches">
//           <div className="section-heading">
//             <div>
//               <div className="section-kicker">
//                 <span /> SMART MATCHING
//               </div>
//               <h2>
//                 Possible matches<span>.</span>
//               </h2>
//               <p>
//                 CampusFind compares lost and found reports to help items
//                 get back to their owners.
//               </p>
//             </div>

//             <label className="student-picker">
//               VIEW AS STUDENT
//               <select
//                 value={currentUserId}
//                 onChange={(event) => setCurrentUserId(event.target.value)}
//               >
//                 <option value="101">Student 101</option>
//                 <option value="102">Student 102</option>
//                 <option value="103">Student 103</option>
//                 <option value="104">Student 104</option>
//               </select>
//             </label>
//           </div>

//           {matchLoading ? (
//             <div className="matches-loading">
//               <div className="loader" />
//               <p>Checking potential matches...</p>
//             </div>
//           ) : matchError ? (
//             <div className="matches-empty">
//               <span className="state-emoji">⚠</span>
//               <h3>Could not load matches.</h3>
//               <p>{matchError}</p>
//               <button
//                 className="button button-dark"
//                 onClick={() => fetchMatches()}
//               >
//                 Try again ↻
//               </button>
//             </div>
//           ) : matches.length === 0 ? (
//             <div className="matches-empty">
//               <span className="state-emoji">✳</span>
//               <h3>No potential matches yet.</h3>
//               <p>
//                 When a lost report and a found report match, the details
//                 will appear here for both students.
//               </p>
//               <button
//                 className="button button-dark"
//                 onClick={() => openReport("lost")}
//               >
//                 Report a lost item ↗
//               </button>
//             </div>
//           ) : (
//             <>
//               <div className="matches-summary">
//                 <span>
//                   {matches.length} potential match{matches.length !== 1 ? "es" : ""}
//                 </span>
//                 <span>Signed in as demo student {currentUserId}</span>
//               </div>

//               <div className="matches-grid">
//                 {matches.map((match) => {
//                   const isLostOwner =
//                     Number(currentUserId) === Number(match.lostReportedBy);

//                   const isConfirmed = match.status === "confirmed";

//                   return (
//                     <article className="match-card" key={match._id}>
//                       <div className="match-card-top">
//                         <span className="match-score">
//                           {match.matchScore}% MATCH
//                         </span>

//                         <span
//                           className={
//                             isConfirmed
//                               ? "match-status confirmed"
//                               : "match-status"
//                           }
//                         >
//                           {isConfirmed ? "RETURNED" : "PENDING"}
//                         </span>
//                       </div>

//                       <div className="match-details-heading">
//                         <h3>We found a possible match!</h3>
//                         <p>
//                           Compare the details below to verify the item.
//                         </p>
//                       </div>

//                       {renderMatchItem("LOST REPORT", match.lostItem)}
//                       {renderMatchItem("FOUND REPORT", match.foundItem)}

//                       <div className="match-card-meta">
//                         <span>
//                           Match created: {formatDate(match.createdAt)}
//                         </span>
//                       </div>

//                       {isConfirmed ? (
//                         <div className="match-confirmed-message">
//                           ✓ This item has been marked as returned.
//                         </div>
//                       ) : isLostOwner ? (
//                         <button
//                           className="button button-dark match-confirm-button"
//                           onClick={() => confirmMatch(match._id)}
//                           disabled={confirmingId === match._id}
//                         >
//                           {confirmingId === match._id
//                             ? "Confirming..."
//                             : "Confirm & Return ✓"}
//                         </button>
//                       ) : (
//                         <div className="match-waiting-message">
//                           Waiting for the lost item's owner to verify this match.
//                         </div>
//                       )}
//                     </article>
//                   );
//                 })}
//               </div>
//             </>
//           )}
//         </section>

//         {/* COMMUNITY BOARD */}
//         <section className="items-section" id="items">
//           <div className="section-heading">
//             <div>
//               <div className="section-kicker">
//                 <span /> THE COMMUNITY BOARD
//               </div>
//               <h2>
//                 Things looking
//                 <br />
//                 for their people<span>.</span>
//               </h2>
//               <p>Browse the board. You never know what you'll find.</p>
//             </div>

//             <button
//               className="button button-dark desktop-report"
//               onClick={() => openReport("found")}
//             >
//               Post a found item <span>↗</span>
//             </button>
//           </div>

//           <div className="filters-panel">
//             <div className="filter-tabs">
//               {[
//                 { value: "all", label: "Everything" },
//                 { value: "lost", label: "✕ Lost" },
//                 { value: "found", label: "✓ Found" },
//               ].map((tab) => (
//                 <button
//                   key={tab.value}
//                   className={
//                     activeTab === tab.value
//                       ? "filter-tab selected"
//                       : "filter-tab"
//                   }
//                   onClick={() => setActiveTab(tab.value)}
//                 >
//                   {tab.label}
//                 </button>
//               ))}
//             </div>

//             <div className="filter-controls">
//               <label className="search-box">
//                 <span>⌕</span>
//                 <input
//                   type="search"
//                   placeholder="Search name, color, location..."
//                   value={search}
//                   onChange={(event) => setSearch(event.target.value)}
//                 />
//                 {search && (
//                   <button
//                     type="button"
//                     onClick={() => setSearch("")}
//                     aria-label="Clear search"
//                   >
//                     ×
//                   </button>
//                 )}
//               </label>

//               <select
//                 className="category-select"
//                 value={category}
//                 onChange={(event) => setCategory(event.target.value)}
//                 aria-label="Filter by category"
//               >
//                 <option value="all">All categories</option>
//                 <option value="Electronics">Electronics</option>
//                 <option value="Accessories">Accessories</option>
//                 <option value="Documents">Documents</option>
//                 <option value="Bottle">Bottle</option>
//                 <option value="Clothing">Clothing</option>
//                 <option value="Other">Other</option>
//               </select>
//             </div>
//           </div>

//           {loading ? (
//             <div className="state-panel">
//               <div className="loader" />
//               <p>Finding your items...</p>
//             </div>
//           ) : error ? (
//             <div className="state-panel">
//               <span className="state-emoji">⚠</span>
//               <h3>We couldn't load the board.</h3>
//               <p>{error}</p>
//               <button
//                 className="button button-dark"
//                 onClick={fetchItems}
//               >
//                 Try again ↻
//               </button>
//             </div>
//           ) : filteredItems.length === 0 ? (
//             <div className="state-panel empty-panel">
//               <span className="state-emoji">✳</span>
//               <h3>No items found.</h3>
//               <p>
//                 Try another search or be the first to report an item.
//               </p>
//               <button
//                 className="button button-dark"
//                 onClick={() =>
//                   openReport(activeTab === "found" ? "found" : "lost")
//                 }
//               >
//                 Report an item ↗
//               </button>
//             </div>
//           ) : (
//             <div className="items-grid">
//               {filteredItems.map((item, index) => (
//                 <article
//                   className="item-card"
//                   key={item._id}
//                   style={{ "--card-index": index }}
//                 >
//                   <div className={`item-visual visual-${index % 5}`}>
//                     <span className="visual-decoration decoration-one">✳</span>
//                     <span className="item-symbol">{getItemIcon(item)}</span>

//                     <span className={`status-pill ${item.reportType}`}>
//                       <span />
//                       {item.reportType === "lost" ? "LOST ITEM" : "FOUND ITEM"}
//                     </span>

//                     <span className="visual-number">
//                       {String(index + 1).padStart(2, "0")}
//                     </span>
//                   </div>

//                   <div className="item-info">
//                     <div className="item-category-row">
//                       <span className="item-category">{item.category}</span>
//                       <span className="item-date">
//                         {formatDate(item.dateReported || item.createdAt)}
//                       </span>
//                     </div>

//                     <h3>{item.itemName}</h3>

//                     <div className="item-detail">
//                       <span>◉</span> {item.color}
//                     </div>

//                     <div className="item-detail">
//                       <span>⌖</span> {item.location}
//                     </div>

//                     <div className="item-card-footer">
//                       <span className="item-status-text">
//                         {item.status === "returned"
//                           ? "✓ Returned"
//                           : item.reportType === "lost"
//                             ? "Still looking"
//                             : "Waiting for owner"}
//                       </span>
//                       <span className="item-card-arrow">↗</span>
//                     </div>
//                   </div>
//                 </article>
//               ))}
//             </div>
//           )}

//           {!loading && !error && filteredItems.length > 0 && (
//             <div className="board-footer">
//               <span>
//                 SHOWING {filteredItems.length} OF {items.length} ITEMS
//               </span>
//               <span>
//                 Good things happen when we look out for each other ✳
//               </span>
//             </div>
//           )}
//         </section>

//         {/* HOW IT WORKS */}
//         <section className="how-section" id="how-it-works">
//           <div className="how-intro">
//             <div className="section-kicker light-kicker">
//               <span /> EASY AS 1, 2, 3
//             </div>
//             <h2>
//               Lost things.
//               <br />
//               Found people.
//             </h2>
//             <p>Getting your stuff back shouldn't be complicated.</p>
//           </div>

//           <div className="how-steps">
//             <article className="how-step">
//               <span className="step-number">01</span>
//               <div className="step-icon step-yellow">＋</div>
//               <h3>Post it</h3>
//               <p>
//                 Report something you've lost or found in just a few clicks.
//               </p>
//             </article>

//             <article className="how-step">
//               <span className="step-number">02</span>
//               <div className="step-icon step-purple">⌕</div>
//               <h3>Find it</h3>
//               <p>
//                 CampusFind compares reports and highlights possible matches.
//               </p>
//             </article>

//             <article className="how-step">
//               <span className="step-number">03</span>
//               <div className="step-icon step-green">♡</div>
//               <h3>Return it</h3>
//               <p>
//                 The lost item's owner verifies the match and confirms its return.
//               </p>
//             </article>
//           </div>
//         </section>

//         {/* BOTTOM CTA */}
//         <section className="bottom-cta">
//           <div>
//             <span className="cta-spark">✳</span>
//             <h2>
//               Be someone's
//               <br />
//               <span>good news today.</span>
//             </h2>
//             <p>It takes a campus to bring things home.</p>
//           </div>

//           <div className="cta-actions">
//             <button
//               className="button button-dark"
//               onClick={() => openReport("lost")}
//             >
//               I lost something ↗
//             </button>
//             <button
//               className="button button-outline"
//               onClick={() => openReport("found")}
//             >
//               I found something ✳
//             </button>
//           </div>
//         </section>
//       </main>

//       {/* FOOTER */}
//       <footer className="footer">
//         <a className="brand footer-brand" href="#home">
//           <span className="brand-icon">C<span>.</span></span>
//           <span>
//             campus<span className="brand-light">find</span>
//           </span>
//         </a>

//         <p>Made with care for the campus community.</p>
//         <a href="#home">Back to top ↑</a>
//       </footer>

//       {/* REPORT MODAL */}
//       {showForm && (
//         <div
//           className="modal-backdrop"
//           onMouseDown={(event) => {
//             if (
//               event.target === event.currentTarget &&
//               !submitting
//             ) {
//               setShowForm(false);
//             }
//           }}
//         >
//           <section
//             className="report-modal"
//             role="dialog"
//             aria-modal="true"
//             aria-labelledby="report-title"
//           >
//             <div className="modal-header">
//               <div>
//                 <div className="section-kicker">
//                   <span /> COMMUNITY REPORT
//                 </div>
//                 <h2 id="report-title">
//                   Let's bring it <span>home.</span>
//                 </h2>
//                 <p>Tell us a little about the item.</p>
//               </div>

//               <button
//                 className="modal-close"
//                 onClick={() => setShowForm(false)}
//                 disabled={submitting}
//                 aria-label="Close form"
//               >
//                 ×
//               </button>
//             </div>

//             <div className="report-type-picker">
//               <button
//                 type="button"
//                 className={
//                   form.reportType === "lost"
//                     ? "type-option chosen lost-choice"
//                     : "type-option"
//                 }
//                 onClick={() =>
//                   setForm({ ...form, reportType: "lost" })
//                 }
//               >
//                 <span>⌕</span>
//                 <strong>I've lost it</strong>
//                 <small>Help me find it</small>
//               </button>

//               <button
//                 type="button"
//                 className={
//                   form.reportType === "found"
//                     ? "type-option chosen found-choice"
//                     : "type-option"
//                 }
//                 onClick={() =>
//                   setForm({ ...form, reportType: "found" })
//                 }
//               >
//                 <span>✳</span>
//                 <strong>I've found it</strong>
//                 <small>Help it get home</small>
//               </button>
//             </div>

//             <form onSubmit={submitReport} className="report-form">
//               <label>
//                 Item name
//                 <input
//                   name="itemName"
//                   value={form.itemName}
//                   onChange={updateForm}
//                   placeholder="e.g. Blue water bottle"
//                   required
//                   maxLength={100}
//                 />
//               </label>

//               <div className="form-row">
//                 <label>
//                   Category
//                   <select
//                     name="category"
//                     value={form.category}
//                     onChange={updateForm}
//                     required
//                   >
//                     <option>Electronics</option>
//                     <option>Accessories</option>
//                     <option>Documents</option>
//                     <option>Bottle</option>
//                     <option>Clothing</option>
//                     <option>Other</option>
//                   </select>
//                 </label>

//                 <label>
//                   Color
//                   <input
//                     name="color"
//                     value={form.color}
//                     onChange={updateForm}
//                     placeholder="e.g. Blue"
//                     required
//                     maxLength={50}
//                   />
//                 </label>
//               </div>

//               <label>
//                 Where was it lost or found?
//                 <input
//                   name="location"
//                   value={form.location}
//                   onChange={updateForm}
//                   placeholder="e.g. Library, Block 32"
//                   required
//                   maxLength={150}
//                 />
//               </label>

//               <label>
//                 Reporter user ID
//                 <input
//                   name="reportedBy"
//                   type="number"
//                   min="1"
//                   value={form.reportedBy}
//                   onChange={updateForm}
//                   required
//                 />
//                 <small className="field-hint">
//                   Demo mode: use an existing user ID, such as 101–104.
//                 </small>
//               </label>

//               <button
//                 className="button button-dark submit-button"
//                 disabled={submitting}
//                 type="submit"
//               >
//                 {submitting ? "Submitting report..." : "Submit report"}
//                 <span>↗</span>
//               </button>

//               <p className="privacy-note">
//                 Please don't include passwords or sensitive personal information.
//               </p>
//             </form>
//           </section>
//         </div>
//       )}
//     </div>
//   );
// }

// export default App;
