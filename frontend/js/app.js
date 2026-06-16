/**
 * app.js — Controlador principal SignLINGO (rediseño)
 */

const SECTIONS = ["learn", "practice", "spell", "train"];

const App = {
  currentSection: "learn",
  currentCountry: "lsc",
  learnMode:    null,
  practiceMode: null,
  collectMode:  null,
  spellMode:    null,
  _collectInited: false,

  async init() {
    await this._checkHealth();
    this._setupNav();
    this._setupCountrySelector();

    this.learnMode    = new LearnMode();
    this.practiceMode = new PracticeMode();
    this.collectMode  = new CollectMode();
    this.spellMode    = new SpellMode();

    await this.learnMode.init();
    this.navigateTo("learn");
    this._setupReveal();
  },

  async _checkHealth() {
    const health = await ApiClient.health();
    if (!health) {
      document.getElementById("no-model-banner")?.classList.add("show");
      return;
    }
    const lscTrained = Boolean(health.model_loaded?.lsc);
    if (!lscTrained) {
      const banner = document.getElementById("no-model-banner");
      if (banner) {
        banner.textContent = "Modelo de IA no entrenado. Ejecuta: python scripts/generate_data.py && python scripts/train_model.py";
        banner.classList.add("show");
      }
    }
  },

  navigateTo(section, opts = {}) {
    SECTIONS.forEach(s => {
      document.getElementById(`section-${s}`)?.classList.toggle("active", s === section);
      // update nav buttons
      document.querySelector(`.nav-btn[data-section="${s}"]`)?.classList.toggle("active", s === section);
    });
    this.currentSection = section;

    if (section === "learn") {
      this.learnMode.setCountry(this.currentCountry);
      // sync category sidebar
      const activeFilter = document.querySelector("#category-filters .filter-btn-v.active");
      if (activeFilter) this.learnMode.setCategory(activeFilter.dataset.cat || "all");
    } else if (section === "practice") {
      if (this.spellMode?.isActive) this.spellMode.stop();
      if (opts.signs) {
        this.practiceMode.start(this.currentCountry, opts.signs);
      } else if (!this.practiceMode.isActive) {
        this.practiceMode.start(this.currentCountry);
      }
    } else if (section === "spell") {
      if (this.practiceMode?.isActive) this.practiceMode.stop();
      this.spellMode.setCountry(this.currentCountry);
      if (!this.spellMode.isActive) {
        setTimeout(() => this.spellMode.startQuiz(), 250);
      }
    } else if (section === "train") {
      if (!this._collectInited) {
        this._collectInited = true;
        const country = this.currentCountry === "lsc" ? this.currentCountry : "lsc";
        const sel = document.getElementById("collect-country-select");
        if (sel) sel.value = country;
        this.collectMode.init(country);
      }
    }
  },

  setCountry(country) {
    this.currentCountry = "lsc";
    document.querySelectorAll(".country-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.country === "lsc");
    });
    if (this.currentSection === "learn") {
      this.learnMode.setCountry("lsc");
    } else if (this.currentSection === "practice") {
      this.practiceMode.stop();
      this.practiceMode.start("lsc");
    } else if (this.currentSection === "spell") {
      this.spellMode.setCountry("lsc");
    }
  },

  _setupNav() {
    document.querySelectorAll(".nav-btn[data-section]").forEach(btn => {
      btn.addEventListener("click", () => this.navigateTo(btn.dataset.section));
    });
  },

  _setupCountrySelector() {
    document.querySelectorAll(".country-btn").forEach(btn => {
      btn.addEventListener("click", () => this.setCountry("lsc"));
    });
    document.querySelectorAll(".diff-option").forEach(opt => {
      opt.addEventListener("click", () => {
        document.querySelectorAll(".diff-option").forEach(o => o.classList.remove("active"));
        opt.classList.add("active");
        const diff = opt.dataset.diff;
        if (this.spellMode) this.spellMode.setDifficulty(diff);
        document.getElementById("difficulty-dropdown")?.classList.add("hidden");
      });
    });
  },

  async loadProgressModal() {
    const summary = await ApiClient.getProgress();
    if (!summary) return;

    // Stats
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl("stat-attempts", summary.total_attempts);
    setEl("stat-accuracy", summary.total_attempts > 0 ? `${Math.round(summary.overall_accuracy * 100)}%` : "—");
    setEl("stat-streak", summary.best_streak);
    setEl("stat-mastered", summary.signs_mastered);

    // Weekly progress circle
    const pct = summary.total_attempts > 0 ? Math.min(100, Math.round(summary.overall_accuracy * 100)) : 0;
    setEl("weekly-pct", `${pct}%`);
    setEl("modal-weekly-circle", `${pct}%`);
    setEl("modal-weekly-sub", pct >= 70 ? "¡Vamos muy bien!" : pct >= 40 ? "Sigue así" : "¡Empieza a practicar!");
    setEl("modal-congrats-text", summary.signs_mastered > 0 ? "¡Felicidades, lo has logrado!" : "¡Sigue practicando para lograr señas!");

    // Mastered grid
    const masteredGrid = document.getElementById("mastered-grid");
    if (masteredGrid) {
      const mastered = summary.by_sign?.filter(s => s.mastered) || [];
      if (mastered.length === 0) {
        masteredGrid.innerHTML = `<p style="font-family:'Martian Mono',monospace; font-size:0.72rem; color:rgba(170,202,223,0.5); grid-column:1/-1;">¡Practica para dominar señas!</p>`;
      } else {
        masteredGrid.innerHTML = mastered.map(s => `
          <div class="mastered-badge" style="background:rgba(34,86,136,0.25); color:var(--blue-light); border-color:rgba(170,202,223,0.2);">
            <div style="font-size:0.9rem;">✓</div>
            <div>${s.sign_id}</div>
          </div>
        `).join("");
      }
    }

    // Dynamic achievements
    const ach = document.getElementById("modal-achievements");
    if (ach) {
      const levels = [
        { condition: summary.total_attempts >= 1,  text: "Primera seña intentada", cls: "level-1", icon: "/static/icons/logro_trofeo.png" },
        { condition: summary.best_streak >= 5,     text: "Racha de 5 correctas", cls: "level-2", icon: "/static/icons/logro_fuego.png" },
        { condition: summary.signs_mastered >= 10, text: "10 señas dominadas", cls: "level-3", icon: "/static/icons/logro_estrella.png" },
        { condition: summary.signs_mastered >= 26, text: "Maestro del Alfabeto", cls: "level-4", icon: "/static/icons/logro_destello.png" },
      ];
      ach.innerHTML = levels.map(l => `
        <div class="progress-achievement-bar ${l.cls}" style="${!l.condition ? 'opacity:0.35;' : ''}">
          <img class="progress-achievement-icon" src="${l.icon}" alt="" />
          <span>${l.text}</span>
        </div>
      `).join("");
    }
  },

  // Legacy — keep for any old references
  async _renderProgress() {
    await this.loadProgressModal();
  },

  _setupReveal() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) e.target.classList.add("visible"); });
    }, { threshold: 0.1 });
    document.querySelectorAll(".reveal").forEach(el => observer.observe(el));
  },
};

window.App = App;
document.addEventListener("DOMContentLoaded", () => App.init());
