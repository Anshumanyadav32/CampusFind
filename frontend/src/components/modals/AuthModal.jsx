export default function AuthModal({
  showAuth,
  setShowAuth,
  authMethod,
  authMode,
  setAuthMode,
  authForm,
  updateAuthForm,
  handleAuthSubmit,
  authSubmitting,
  AUTH_API
}) {
  if (!showAuth) return null;

  return (
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
                <span>✓</span>
                <strong>Log in</strong>
                <small>Already a member</small>
              </button>
              <button
                type="button"
                className={authMode === "register" ? "type-option chosen" : "type-option"}
                onClick={() => setAuthMode("register")}
              >
                <span>✳</span>
                <strong>Register</strong>
                <small>Join the board</small>
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
  );
}
