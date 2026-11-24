import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

import Navbar from "./components/Navbar.jsx";
import Notice from "./components/Notice.jsx";
import Hero from "./components/Hero.jsx";
import FilterBar from "./components/FilterBar.jsx";
import ItemGrid from "./components/ItemGrid.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import ProfileView from "./components/ProfileView.jsx";
import AuthModal from "./components/modals/AuthModal.jsx";
import ReportModal from "./components/modals/ReportModal.jsx";
import DisputeModal from "./components/modals/DisputeModal.jsx";
import ClaimModal from "./components/modals/ClaimModal.jsx";
import AdminDashboard from "./pages/AdminDashboard.jsx";

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
  identifyingMarks: "",
  serialNumber: "",
  brand: "",
  model: "",
  accessories: "",
  physicalDamage: "",
  verificationQuestion: "",
  publicImages: [],
  privateImages: []
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
  const [activePage, setActivePage] = useState(() => {
    return window.location.pathname === "/admin" ? "admin" : "home";
  });
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
  const [claimingItem, setClaimingItem] = useState(null);
  const [disputeMatch, setDisputeMatch] = useState(null);
  const [disputing, setDisputing] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authMethod, setAuthMethod] = useState("loading");
  const [authForm, setAuthForm] = useState(initialAuthForm);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const authSubmitInFlight = useRef(false);
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeType, setNoticeType] = useState("success");

  // Synchronize browser history / popstate
  useEffect(() => {
    function handlePopState() {
      if (window.location.pathname === "/admin") {
        setActivePage("admin");
      } else {
        setActivePage("home");
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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

    window.history.pushState({}, "", "/profile");
    setActivePage("profile");
    await fetchProfile();
  }

  function openAdmin() {
    window.history.pushState({}, "", "/admin");
    setActivePage("admin");
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

  async function submitDispute(matchId, reason) {
    setDisputing(true);
    try {
      const response = await axios.post(`${API}/matches/${matchId}/dispute`, { reason });
      setNoticeType("success");
      setNotice(response.data.message);
      setDisputeMatch(null);
      await fetchProfile();
    } catch (err) {
      setNoticeType("error");
      setNotice(err.response?.data?.message || "Could not submit dispute.");
    } finally {
      setDisputing(false);
    }
  }

  function handleClaimItem(item) {
    if (!currentUser) {
      setNoticeType("error");
      setNotice("Please sign in before submitting an ownership claim.");
      setShowAuth(true);
      return;
    }
    setClaimingItem(item);
  }

  async function handleWithdrawClaim(claim) {
    if (!window.confirm("Are you sure you want to withdraw this ownership claim?")) return;
    try {
      const response = await axios.delete(`${API_BASE_URL}/claims/${claim._id}/withdraw`);
      setNoticeType("success");
      setNotice(response.data.message || "Claim withdrawn successfully.");
      await fetchProfile();
    } catch (err) {
      setNoticeType("error");
      setNotice(err.response?.data?.message || "Could not withdraw this claim.");
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
  const lostCount = items.filter((item) => item.reportType === "lost").length;
  const foundCount = items.filter((item) => item.reportType === "found").length;

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
    if (authSubmitInFlight.current) return;
    setNotice("");

    const parsedStudentId = Number(authForm.studentId.trim());
    if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
      setNoticeType("error");
      setNotice("Enter a valid student ID.");
      return;
    }

    if (authMode === "login" && authForm.password.length < 8) {
      setNoticeType("error");
      setNotice("Password must be at least 8 characters.");
      return;
    }

    authSubmitInFlight.current = true;
    setAuthSubmitting(true);

    try {
      const endpoint = authMode === "login" ? "/login" : "/register";
      const payload =
        authMode === "login"
          ? {
              studentId: parsedStudentId,
              password: authForm.password,
            }
          : {
              studentId: parsedStudentId,
              name: authForm.name,
              email: authForm.email,
              password: authForm.password,
            };

      const response = await axios.post(`${AUTH_API}${endpoint}`, payload);
      const authenticatedUser = response.data.user;
      setCurrentUser(authenticatedUser);
      if (
        authMode === "login" &&
        (authenticatedUser.role === "admin" || authenticatedUser.isAdmin)
      ) {
        openAdmin();
      }
      setForm((previous) => ({
        ...previous,
        reportedBy: String(authenticatedUser.studentId),
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
      authSubmitInFlight.current = false;
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    try {
      await axios.post(`${AUTH_API}/logout`);
      setCurrentUser(null);
      window.history.pushState({}, "", "/");
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

  return (
    <div className="campus-app">
      <Navbar
        currentUser={currentUser}
        activePage={activePage}
        setActivePage={setActivePage}
        openProfile={openProfile}
        openAdmin={openAdmin}
        logout={logout}
        setShowAuth={setShowAuth}
        openReport={openReport}
      />

      <Notice
        notice={notice}
        noticeType={noticeType}
        setNotice={setNotice}
        autoDismissMs={
          notice === "Signed in successfully." || notice === "Signed out successfully."
            ? 1000
            : null
        }
      />

      {activePage === "admin" ? (
        <AdminDashboard
          currentUser={currentUser}
          API_BASE_URL={API_BASE_URL}
          onBackToBoard={() => {
            window.history.pushState({}, "", "/");
            setActivePage("home");
          }}
          onOpenAuth={() => setShowAuth(true)}
        />
      ) : activePage === "profile" ? (
        <ProfileView
          profileLoading={profileLoading}
          profileData={profileData}
          profileForm={profileForm}
          setProfileForm={setProfileForm}
          saveProfile={saveProfile}
          profileSaving={profileSaving}
          currentUser={currentUser}
          confirmMatch={confirmMatch}
          onOpenDispute={(match) => setDisputeMatch(match)}
          onWithdrawClaim={handleWithdrawClaim}
          API_BASE_URL={API_BASE_URL}
          onHandoverSuccess={async () => {
            await fetchProfile();
          }}
          openReport={openReport}
          openProfile={openProfile}
          setActivePage={setActivePage}
        />
      ) : (
        <main>
          <Hero openReport={openReport} />

          <section className="stats-strip" aria-label="Community statistics">
            <div className="stat-block">
              <span className="stat-icon stat-yellow">⌕</span>
              <div>
                <strong>{totalItems}</strong>
                <span>Reports matching filters</span>
              </div>
            </div>
            <div className="stat-block">
              <span className="stat-icon stat-purple">↗</span>
              <div>
                <strong>{lostCount}</strong>
                <span>Lost on this page</span>
              </div>
            </div>
            <div className="stat-block">
              <span className="stat-icon stat-green">✓</span>
              <div>
                <strong>{foundCount}</strong>
                <span>Found on this page</span>
              </div>
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

            <FilterBar
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              search={search}
              setSearch={setSearch}
              category={category}
              setCategory={setCategory}
              setPage={setPage}
              setLoading={setLoading}
            />

            <ItemGrid
              loading={loading}
              error={error}
              filteredItems={filteredItems}
              fetchItems={fetchItems}
              openReport={openReport}
              onClaimItem={handleClaimItem}
              activeTab={activeTab}
              page={page}
              PAGE_SIZE={PAGE_SIZE}
              totalItems={totalItems}
              totalPages={totalPages}
              setPage={setPage}
              setLoading={setLoading}
            />
          </section>

          <HowItWorks openReport={openReport} />
        </main>
      )}

      <footer className="footer">
        <a
          className="brand footer-brand"
          href="#home"
          onClick={(e) => {
            e.preventDefault();
            window.history.pushState({}, "", "/");
            setActivePage("home");
          }}
        >
          <span className="brand-icon">C<span>.</span></span>
          <span>campus<span className="brand-light">find</span></span>
        </a>
        <p>Made with care for the campus community.</p>
        <a href="#home">Back to top ↑</a>
      </footer>

      <ReportModal
        showForm={showForm}
        setShowForm={setShowForm}
        submitting={submitting}
        form={form}
        setForm={setForm}
        submitReport={submitReport}
        updateForm={updateForm}
        currentUser={currentUser}
        API_BASE_URL={API_BASE_URL}
      />

      <AuthModal
        showAuth={showAuth}
        setShowAuth={setShowAuth}
        authMethod={authMethod}
        authMode={authMode}
        setAuthMode={setAuthMode}
        authForm={authForm}
        updateAuthForm={updateAuthForm}
        handleAuthSubmit={handleAuthSubmit}
        authSubmitting={authSubmitting}
        AUTH_API={AUTH_API}
      />

      <DisputeModal
        match={disputeMatch}
        onClose={() => setDisputeMatch(null)}
        onSubmitDispute={submitDispute}
        submitting={disputing}
      />

      <ClaimModal
        item={claimingItem}
        showClaimModal={Boolean(claimingItem)}
        onClose={() => setClaimingItem(null)}
        currentUser={currentUser}
        API_BASE_URL={API_BASE_URL}
        onClaimSubmitted={async (message) => {
          setNotice(message);
          setNoticeType("success");
          if (activePage === "profile") {
            await fetchProfile();
          }
        }}
      />
    </div>
  );
}

export default App;
