export default function HowItWorks({ openReport }) {
  return (
    <>
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
          <button className="button button-dark" onClick={() => openReport("lost")}>
            I lost something ↗
          </button>
          <button className="button button-outline" onClick={() => openReport("found")}>
            I found something ✳
          </button>
        </div>
      </section>
    </>
  );
}
