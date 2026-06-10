/* Foundations chat widget — floating launcher that posts to /api/chat. */
(function () {
  "use strict";

  // Mount UI only if /api/health is healthy.
  async function isReady() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) return false;
      const d = await r.json();
      return !!(d && d.ok && d.has_openai_key);
    } catch { return false; }
  }

  function mount() {
    const launcher = document.createElement("button");
    launcher.id = "anc-chat-launcher";
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "anc-chat-panel");
    launcher.setAttribute("title", "Ask the Foundations bot");
    launcher.innerHTML = `<span class="anc-chat-open-icon">💬</span><span class="anc-chat-close-icon">×</span>`;
    document.body.appendChild(launcher);

    const panel = document.createElement("aside");
    panel.id = "anc-chat-panel";
    panel.innerHTML = `
      <div class="anc-chat-head">
        <span class="dot" aria-hidden="true"></span>
        <span>Foundations Assistant</span>
      </div>
      <div class="anc-chat-body" id="anc-chat-body" aria-live="polite"></div>
      <form class="anc-chat-form" id="anc-chat-form" autocomplete="off">
        <input type="text" id="anc-chat-input" placeholder="Ask about foundations…" required>
        <button type="submit" id="anc-chat-send">Send</button>
      </form>
    `;
    document.body.appendChild(panel);

    const body  = panel.querySelector("#anc-chat-body");
    const form  = panel.querySelector("#anc-chat-form");
    const input = panel.querySelector("#anc-chat-input");
    const btn   = panel.querySelector("#anc-chat-send");

    addBot("Hi — I'm the Foundations assistant. Ask me about the intro-level coaching material here. For advanced ECHO topics, you'll need access to the full ECHO Manual.");

    launcher.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) input.focus();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      addUser(q);
      input.value = "";
      btn.disabled = true;
      const typing = addBot("…");
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q }),
        });
        const data = await r.json().catch(() => null);
        typing.remove();
        if (!r.ok || !data || !data.ok) {
          addBot(data?.error || "Sorry — something went wrong. Try refreshing the page.", { refused: true });
        } else {
          addBot(data.answer || "(no answer)", { refused: !!data.refused, sources: data.sources });
        }
      } catch (err) {
        typing.remove();
        addBot("Network error. Refresh the page and try again.", { refused: true });
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });

    function addUser(text) {
      const d = document.createElement("div");
      d.className = "anc-chat-msg user";
      d.textContent = text;
      body.appendChild(d);
      body.scrollTop = body.scrollHeight;
      return d;
    }
    function addBot(text, opts = {}) {
      const d = document.createElement("div");
      d.className = "anc-chat-msg bot" + (opts.refused ? " refused" : "");
      d.textContent = text;
      if (opts.sources && opts.sources.length) {
        const chips = document.createElement("div");
        chips.className = "anc-chat-sources";
        opts.sources.slice(0, 6).forEach(s => {
          const chip = document.createElement("span");
          chip.className = "anc-chat-chip" + (s.canonical ? " canonical" : "");
          chip.textContent = (s.canonical ? "📘 " : "📄 ") + (s.label || "source");
          chips.appendChild(chip);
        });
        d.appendChild(chips);
      }
      body.appendChild(d);
      body.scrollTop = body.scrollHeight;
      return d;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", async () => { if (await isReady()) mount(); });
  } else {
    (async () => { if (await isReady()) mount(); })();
  }
})();
