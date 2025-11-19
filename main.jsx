function App() {
  const [showDisclaimer, setShowDisclaimer] = React.useState(false);

  React.useEffect(function () {
    try {
      var stored =
        typeof window !== "undefined" && window.localStorage
          ? window.localStorage.getItem("oseDisclaimerAccepted")
          : null;
      if (stored !== "yes") {
        setShowDisclaimer(true);
      }
    } catch (e) {
      // If localStorage is unavailable, default to showing the disclaimer
      setShowDisclaimer(true);
    }
  }, []);

  function handleAcceptDisclaimer() {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("oseDisclaimerAccepted", "yes");
      }
    } catch (e) {
      // ignore storage errors; just hide the modal
    }
    setShowDisclaimer(false);
  }

  return (
    <>
      {showDisclaimer && <DisclaimerModal onAccept={handleAcceptDisclaimer} />}
      <Header />
      <div id="page">
        {window.location.pathname.toLowerCase().indexOf("download") !== -1 ? (
          <>
            <DownloadPage />
            <Footer />
          </>
        ) : window.location.pathname.toLowerCase().indexOf("game") !== -1 ? (
          <>
            <GamePage />
            <Footer />
          </>
        ) : window.location.pathname.toLowerCase().indexOf("community") !== -1 ? (
          <>
            <CommunityPage />
            <Footer />
          </>
        ) : (
          <>
            <HeroSection />
            <Footer />
          </>
        )}
      </div>
    </>
  );
}

function DisclaimerModal(props) {
  return (
    <div className="disclaimer-backdrop">
      <div className="disclaimer-modal">
        <h1>Unofficial fan-made mod</h1>
        <p>
          Minecraft Oldschool Edition is a fan-made modification for Minecraft: Java Edition. It is
          not an official Minecraft product and is not affiliated with, approved by, or endorsed by
          Mojang Studios or Microsoft.
        </p>
        <p>
          To play Minecraft Oldschool Edition you must own a legitimate copy of Minecraft. Please
          support the original developers by purchasing the game from{" "}
          <a href="https://www.minecraft.net/" target="_blank" rel="noreferrer">
            minecraft.net
          </a>
          .
        </p>
        <div className="disclaimer-actions">
          <button
            type="button"
            className="btn disclaimer-btn"
            onClick={props.onAccept}
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="top-bar">
      <div className="top-inner">
        <div className="logo">
          <a href="index.html">
            <img src="assets/logo.png" alt="Minecraft Oldschool Edition" />
          </a>
        </div>
        <nav className="nav-links">
          <a href="index.html">Home</a>
          <a href="game.html">Game</a>
          <a href="download.html">Download</a>
          <a href="community.html">Community</a>
          <a href="#">Help</a>
        </nav>
      </div>
    </header>
  );
}

function HeroSection() {
  return (
    <section className="hero-row">
      <div className="hero-left">
        <div className="hero-video">
          <iframe
            src="https://www.youtube.com/embed/MmB9b5njVbA"
            title="Minecraft Trailer"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          ></iframe>
        </div>
        <p className="hero-copy">
          Minecraft Oldschool Edition is a fan-made project that brings classic Alpha and Beta
          Minecraft into the modern era. It restores the old terrain, pacing and atmosphere while
          adding a cleaner rendering pipeline, support for higher‑resolution textures and a handful
          of carefully chosen quality-of-life improvements.
        </p>
        <p className="hero-stats">
          Oldschool Edition is shipped as its own client and server, designed to run through{" "}
          <strong>Prism Launcher</strong>. The included updater (and optional standalone{" "}
          <code>patch.jar</code>) keeps your installs in sync with new releases without constant
          manual downloads.
        </p>
      </div>
      <div className="hero-right">
        <img src="assets/animals.png" alt="Steve with pig and sheep" className="hero-animals" />
        <a href="download.html" className="download-btn">
          <img src="assets/download_now.png" alt="Download!" />
        </a>
        <p className="hero-play">
          Play Minecraft
          <br />
          <a href="download.html">Download the client</a>
        </p>
        <p className="hero-classic">
          Server
          <br />
          <a href="download.html">Get the server</a>
        </p>
      </div>
    </section>
  );
}

function DownloadPage() {
  return (
    <main className="download-page">
      <h1>Download</h1>
      <p className="download-intro">
        When you have installed <strong>Prism Launcher</strong>, you can download the Oldschool
        Edition client and server from here. The client instance can update itself to the latest
        release using the built-in updater.
      </p>

      <section className="download-section">
        <h2>Minecraft Oldschool Edition Client (requires Prism Launcher)</h2>
        <p>
          Download the client instance archive and import it into Prism Launcher to start playing
          Oldschool Edition.
        </p>
        <p>
          <a className="download-link" href="#">
            Download client (ZIP)
          </a>
        </p>
      </section>

      <ServerDownloadSection />

      <p className="download-note">
        Note: <strong>Prism Launcher</strong> is required to play Minecraft Oldschool Edition. You
        can download it from{" "}
        <a href="https://prismlauncher.org" target="_blank" rel="noreferrer">
          prismlauncher.org
        </a>
        .
      </p>
    </main>
  );
}

function ServerDownloadSection() {
  const [serverUrl, setServerUrl] = React.useState(null);

  React.useEffect(function () {
    fetch(
      "https://api.github.com/repos/MinecraftOldschoolEdition/downloads/releases/latest"
    )
      .then(function (res) {
        if (!res.ok) {
          throw new Error("GitHub API error " + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.assets || !data.assets.length) {
          return;
        }
        var assets = data.assets;
        var asset = null;

        // Prefer an asset that looks like a server jar
        for (var i = 0; i < assets.length; i++) {
          var name = (assets[i].name || "").toLowerCase();
          if (name.indexOf("server") !== -1 && /\.jar$/.test(name)) {
            asset = assets[i];
            break;
          }
        }

        // Fallback to any .jar if a specific server jar isn't found
        if (!asset) {
          for (var j = 0; j < assets.length; j++) {
            var name2 = (assets[j].name || "").toLowerCase();
            if (/\.jar$/.test(name2)) {
              asset = assets[j];
              break;
            }
          }
        }

        if (asset && asset.browser_download_url) {
          setServerUrl(asset.browser_download_url);
        }
      })
      .catch(function (err) {
        console.error(
          "[Oldschool Edition site] Failed to resolve latest server.jar from GitHub releases",
          err
        );
      });
  }, []);

  var fallbackUrl =
    "https://github.com/MinecraftOldschoolEdition/downloads/releases/latest";

  return (
    <section className="download-section">
      <h2>Minecraft Oldschool Edition Server</h2>
      <p>
        Run your own server that matches the Oldschool Edition client. Use this jar on any platform
        with Java installed.
      </p>
      <p>
        <a
          className="download-link"
          href={serverUrl || fallbackUrl}
          target="_blank"
          rel="noreferrer"
        >
          Download server (JAR)
        </a>
      </p>
    </section>
  );
}

function GamePage() {
  return (
    <main className="game-page">
      <h1>About the game</h1>
      <p className="game-intro">
        Minecraft Oldschool Edition is a modded experience that recreates the feel of classic Alpha
        and Beta Minecraft while still running on modern versions of the game. It brings back old
        terrain, pacing and atmosphere, then layers on stability fixes, quality-of-life tweaks and
        a modern rendering / resource-pack pipeline.
      </p>

      <section className="game-section">
        <h2>Origins</h2>
        <p>
          Oldschool Edition grew out of a love for the early days of Minecraft and a desire to make
          them practical to play on modern setups. Rather than freezing the game on a single Alpha
          jar, the project rebuilds that experience on top of a modern base: classic and Alpha Snow
          world generators, sky-style maps and restored sounds all run through a new atlas-based
          texture engine with support for 32×32 packs (and higher in later versions). Along the
          way, rough edges are smoothed out so the nostalgia doesn’t come with 2010-era headaches.
        </p>
      </section>

      <section className="game-section">
        <h2>Development and philosophy</h2>
        <p>
          Oldschool Edition is built iteratively, release by release. Under the hood the game now
          uses registries on both client and server to prepare for a proper modding API and cleaner
          content additions. Client updates focus on making the classic sandbox nicer to live in:
          an Accessibility menu with subtitles, an overhauled console with tab-completion,
          copy/paste and clickable links, better creative tools like search and huge mushrooms, and
          a steady stream of gameplay and stability improvements.
        </p>
        <p>
          On the server side the philosophy is “classic gameplay, admin-friendly tooling”.
          UberBukkit replaces the old ProjectPoseidon base, world types like
          <code> ALPHA_SNOW</code> and <code> CLASSIC</code> are first-class, and moderators get
          commands like <code> /admin</code> and <code> /vanish</code> so they can manage rule
          breakers without extra plugins. Whenever something makes servers or modded setups less
          reliable, it gets addressed quickly in new releases.
        </p>
      </section>

      <section className="game-section">
        <h2>The future</h2>
        <p>
          Future versions continue in the same direction as the 1.0–1.3 updates: more authentic
          Alpha/Beta-inspired content (world types, mobs and blocks), deeper registry-driven
          systems, and more server-side polish so Oldschool Edition is easy to host and moderate.
          Features like the FPS limiter, rebalanced block-breaking speeds, Classic Nether worlds,
          and improved creative tools show how the mod modernises rough edges without losing the
          original challenge.
        </p>
        <p>
          Oldschool Edition is distributed as a dedicated client and server package that you run
          through <strong>Prism Launcher</strong>. The Prism instance includes a built-in updater
          and optional standalone <code>patch.jar</code> support so you don’t need to redownload
          everything for each release, and servers can track the same release cadence as the
          client.
        </p>
      </section>
    </main>
  );
}

function CommunityPage() {
  return (
    <main className="community-page">
      <h1>Community</h1>
      <p className="community-intro">
        Here are some active community resources for discussing Minecraft Oldschool Edition and old Minecraft and
        hanging out with other classic Minecraft fans. These sites and servers are run by the
        community, not by Mojang.
      </p>

      <section className="community-section">
        <h2>Official resources</h2>
        <ul>
          <li>
            <a href="https://discord.gg/fKsp5ZUyeE" target="_blank" rel="noreferrer">
              Discord &mdash; the main hub for chatting, support and announcements.
            </a>
          </li>
          <li>
            <a href="https://github.com/MinecraftOldschoolEdition" target="_blank" rel="noreferrer">
              GitHub &mdash; source code and issue tracker.
            </a>
          </li>
          <li>
            <a href="updates.html">
              Update News &mdash; latest patch notes for Minecraft Oldschool Edition.
            </a>
          </li>
        </ul>
      </section>

      <section className="community-section">
        <h2>Forums and communities</h2>
        <ul>
          <li>
            <a
              href="https://www.reddit.com/r/GoldenAgeMinecraft/"
              target="_blank"
              rel="noreferrer"
            >
              r/GoldenAgeMinecraft &mdash; a subreddit for fans of early Minecraft and Oldschool
              Edition servers.
            </a>
          </li>
          <li>
            <a href="https://discord.gg/8Qky5XY" target="_blank" rel="noreferrer">
              Modification Station Server &mdash; a long-running Discord server with a focus on
              discussing and developing mods for old versions of Minecraft.
            </a>
          </li>
          <li>
            <a href="https://oldschoolminecraft.com/" target="_blank" rel="noreferrer">
              Oldschool Minecraft Server &mdash; a community hub and server list for Oldschool
              Edition.
            </a>
          </li>
        </ul>
      </section>
    </main>
  );
}

function Footer() {
  return (
    <footer>
      &quot;Minecraft&quot; and
      related assets are owned by Mojang Studios and Microsoft. This project is not affiliated with
      or endorsed by them.
    </footer>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);


