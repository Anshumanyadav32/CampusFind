import { useEffect, useRef, useState } from "react";

export default function Navbar({
  currentUser,
  activePage,
  setActivePage,
  openProfile,
  openAdmin,
  logout,
  setShowAuth,
  openReport
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(() => window.location.hash);
  const menuToggleRef = useRef(null);
  const isAdmin = currentUser?.role === "admin" || currentUser?.isAdmin;
  const isHomeActive =
    activePage === "home" &&
    activeSection !== "#items" &&
    activeSection !== "#how-it-works";

  useEffect(() => {
    function updateActiveSection() {
      setActiveSection(window.location.hash);
    }

    window.addEventListener("hashchange", updateActiveSection);
    return () => window.removeEventListener("hashchange", updateActiveSection);
  }, []);

  function closeMenu() {
    setIsMenuOpen(false);
  }

  return (
    <nav
      className={`navbar${currentUser && !isAdmin ? " navbar-student" : ""}${isMenuOpen ? " navbar-menu-open" : ""}`}
      aria-label="Main navigation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isMenuOpen) {
          closeMenu();
          menuToggleRef.current?.focus();
        }
      }}
    >
      <a
        className="brand"
        href={isAdmin ? "/admin" : "#home"}
        onClick={(e) => {
          e.preventDefault();
          closeMenu();
          if (isAdmin) {
            setActiveSection("");
            openAdmin();
          } else {
            window.history.pushState({}, "", "/");
            setActivePage("home");
            setActiveSection("");
          }
        }}
      >
        <span className="brand-icon">C<span>.</span></span>
        <span>campus<span className="brand-light">find</span></span>
      </a>

      <div className="nav-menu" id="primary-navigation">
        <div className="nav-links">
          <button
            className={`nav-link${isHomeActive ? " is-active" : ""}`}
            aria-current={isHomeActive ? "page" : undefined}
            onClick={() => {
              closeMenu();
              window.history.pushState({}, "", "/");
              setActivePage("home");
              setActiveSection("");
            }}
          >
            Home
          </button>
          {!isAdmin && (currentUser || activePage === "home") && (
            <>
              <a
                className={`nav-link${activeSection === "#items" ? " is-active" : ""}`}
                href="#items"
                aria-current={activeSection === "#items" ? "location" : undefined}
                onClick={closeMenu}
              >
                Explore items
              </a>
              <a
                className={`nav-link${activeSection === "#how-it-works" ? " is-active" : ""}`}
                href="#how-it-works"
                aria-current={activeSection === "#how-it-works" ? "location" : undefined}
                onClick={closeMenu}
              >
                How it works
              </a>
            </>
          )}
          {isAdmin && (
            <button
              className="nav-admin-link"
              onClick={() => {
                closeMenu();
                openAdmin();
              }}
            >
              Admin Portal <span aria-hidden="true">⚙</span>
            </button>
          )}
        </div>

        <div className="nav-actions">
          <div className="nav-account-actions">
            {currentUser ? (
              <>
                <button className={`button nav-control${isAdmin ? " button-outline" : " nav-secondary"}`} onClick={() => {
                  closeMenu();
                  setActiveSection("");
                  openProfile();
                }}>
                  My profile
                </button>
                <button className={`button nav-control${isAdmin ? " button-outline" : " nav-secondary"}`} onClick={() => {
                  closeMenu();
                  setActiveSection("");
                  logout();
                }}>
                  Log out
                </button>
              </>
            ) : (
              <button className="button button-outline nav-control" onClick={() => {
                closeMenu();
                setShowAuth(true);
              }}>
                Sign in
              </button>
            )}
          </div>
          {!isAdmin && (
            <button
              className="nav-cta"
              onClick={() => {
                closeMenu();
                openReport("lost");
              }}
            >
              Report an item <span>↗</span>
            </button>
          )}
        </div>
      </div>

      <button
        ref={menuToggleRef}
        className="nav-menu-toggle"
        type="button"
        aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={isMenuOpen}
        aria-controls="primary-navigation"
        onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
      >
        <span />
        <span />
        <span />
      </button>
    </nav>
  );
}
