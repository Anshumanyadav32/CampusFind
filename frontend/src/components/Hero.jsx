export default function Hero({ openReport }) {
  return (
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
          <button className="button button-dark" onClick={() => openReport("lost")}>
            I lost something <span>↗</span>
          </button>

          <button className="button button-outline" onClick={() => openReport("found")}>
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
  );
}
