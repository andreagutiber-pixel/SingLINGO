/**
 * learn.js — Biblioteca de señas: tarjetas con fotos reales, filtros y modal.
 */

const SIGN_IMAGES = {
  'A': '/static/signs/cropped/A3.png',
  'B': '/static/signs/cropped/B3.png',
  'C': '/static/signs/cropped/C3.png',
  'D': '/static/signs/cropped/D3.png',
  'E': '/static/signs/cropped/E3.png',
  'F': '/static/signs/cropped/F3.png',
  'G': '/static/signs/cropped/G3.png',
  'H': '/static/signs/cropped/H3.png',
  'I': '/static/signs/cropped/I3.png',
  'J': '/static/signs/cropped/J3.png',
  'K': '/static/signs/cropped/K3.png',
  'L': '/static/signs/cropped/L3.png',
  'M': '/static/signs/cropped/M4.png',
  'N': '/static/signs/cropped/N4.png',
  'Ñ': '/static/signs/cropped/NTILDE.png',
  'O': '/static/signs/cropped/O4.png',
  'P': '/static/signs/cropped/P4.png',
  'Q': '/static/signs/cropped/Q4.png',
  'R': '/static/signs/cropped/R4.png',
  'S': '/static/signs/cropped/S4.png',
  'T': '/static/signs/cropped/T4.png',
  'U': '/static/signs/cropped/U4.png',
  'V': '/static/signs/cropped/V4.png',
  'W': '/static/signs/cropped/W4.png',
  'X': '/static/signs/cropped/X_REF.png',
  'Y': '/static/signs/cropped/Y_REF.png',
  'Z': '/static/signs/cropped/Z_REF.png',
};

function getSignImagePath(signId) {
  if (!signId) return null;
  const key = signId.toUpperCase();
  return SIGN_IMAGES[key] || null;
}

const VOCABULARY_CATEGORY_ORDER = {
  words: ["LAPIZ", "ESFERO", "HOJA", "PERIODICO", "SI", "NO"],
  basic: [
    "HOLA", "BUENOS_DIAS", "BUENAS_TARDES", "BUENAS_NOCHES", "BIEN",
    "COMO_ESTAS", "GRACIAS", "MUCHO_GUSTO", "PERDON", "CON_PERMISO",
    "POR_FAVOR", "BIENVENIDO", "ADIOS",
  ],
  feelings: ["AMOR", "ALEGRIA", "INTERES", "ENOJO", "TRISTEZA", "CELOS", "VERGUENZA"],
};

const VOCABULARY_CATEGORY_SETS = Object.fromEntries(
  Object.entries(VOCABULARY_CATEGORY_ORDER).map(([category, ids]) => [category, new Set(ids)])
);

function normalizeSignId(sign) {
  return String(sign?.id ?? sign?.sign_id ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function signMatchesVocabularyCategory(sign, category) {
  if (category === "all") return true;
  if (category === "alphabet") return sign.category === "alphabet";

  const id = normalizeSignId(sign);
  const rawCategory = sign.category ?? "";
  if (VOCABULARY_CATEGORY_SETS[category]) {
    return VOCABULARY_CATEGORY_SETS[category].has(id);
  }
  return rawCategory === category;
}

function getVocabularyCategoryRank(sign, category) {
  const order = VOCABULARY_CATEGORY_ORDER[category];
  if (!order) return 0;
  const idx = order.indexOf(normalizeSignId(sign));
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

window.signMatchesVocabularyCategory = signMatchesVocabularyCategory;

class LearnMode {
  constructor() {
    this.currentCountry  = "lsc";
    this.currentCategory = "all";
    this.searchQuery     = "";
    this.allSigns        = {};
    this.filteredSigns   = [];

    this.grid  = document.getElementById("signs-grid");
    this.modal = document.getElementById("sign-modal");
  }

  async init() {
    const data = await ApiClient.getAllSigns();
    if (data) this.allSigns = data;
    this.render();
  }

  setCountry(country) {
    this.currentCountry  = country;
    this.currentCategory = "all";
    this.searchQuery     = "";
    document.querySelectorAll("#category-filters .filter-btn-v").forEach(b => b.classList.remove("active"));
    document.querySelector('#category-filters .filter-btn-v[data-cat="all"]')?.classList.add("active");
    this.render();
  }

  setCategory(cat) {
    this.currentCategory = cat;
    this.render();
  }

  setSearch(query) {
    this.searchQuery = (query || "").toLowerCase().trim();
    this.render();
  }

  render() {
    if (!this.grid) return;

    const signs = this.allSigns[this.currentCountry] ?? [];

    let filtered = signs.filter(s => signMatchesVocabularyCategory(s, this.currentCategory));
    filtered = filtered.slice().sort((a, b) =>
      getVocabularyCategoryRank(a, this.currentCategory) - getVocabularyCategoryRank(b, this.currentCategory)
    );

    if (this.searchQuery) {
      filtered = filtered.filter(s =>
        s.id?.toLowerCase().includes(this.searchQuery) ||
        s.name?.toLowerCase().includes(this.searchQuery) ||
        s.category?.toLowerCase().includes(this.searchQuery)
      );
    }

    this.filteredSigns = filtered;

    if (filtered.length === 0) {
      this.grid.innerHTML = `
        <div class="loading" style="grid-column:1/-1;">
          <div class="spinner"></div>
          <span>${this.searchQuery ? "Sin resultados" : "Cargando señas…"}</span>
        </div>`;
      return;
    }

    this.grid.innerHTML = "";

    const unlocked = Math.ceil(filtered.length * 0.75);

    filtered.forEach((sign, idx) => {
      const isLocked = idx >= unlocked;
      const imgPath  = getSignImagePath(sign.id);

      const card = document.createElement("div");
      card.className = `sign-card${isLocked ? " locked" : ""}`;
      card.dataset.signId = sign.id;

      if (isLocked) {
        card.innerHTML = `
          <div class="sign-card-photo locked-photo">
            <span class="lock-icon">🔒</span>
          </div>
          <div class="sign-card-info">
            <div class="sign-name">${sign.id}</div>
            <div class="sign-cat">BLOQUEADA</div>
          </div>`;
      } else if (imgPath) {
        card.innerHTML = `
          <div class="sign-card-photo">
            <img src="${imgPath}" alt="Seña ${sign.id}" class="sign-card-img" loading="lazy" />
          </div>
          <div class="sign-card-info">
            <div class="sign-name">${sign.name ?? "Letra " + sign.id}</div>
            <div class="sign-cat">${sign.category?.toUpperCase() ?? ""}</div>
          </div>`;
        card.addEventListener("click", () => this._openModal(sign));
      } else {
        card.innerHTML = `
          <div class="sign-card-photo">
            <span class="sign-id-big">${sign.id}</span>
          </div>
          <div class="sign-card-info">
            <div class="sign-name">${sign.name ?? "Letra " + sign.id}</div>
            <div class="sign-cat">${sign.category?.toUpperCase() ?? ""}</div>
          </div>`;
        card.addEventListener("click", () => this._openModal(sign));
      }

      this.grid.appendChild(card);
    });

    if (typeof gsap !== "undefined") {
      gsap.from(".sign-card", {
        opacity: 0, y: 12, duration: 0.3, stagger: 0.025, ease: "power2.out",
      });
    }
  }

  _openModal(sign) {
    if (!this.modal) return;
    const imgPath = getSignImagePath(sign.id);

    const fingerNames = ["Pulgar", "Índice", "Medio", "Anular", "Meñique"];
    const fingerDots = (sign.finger_states ?? []).map((up, i) => `
      <div class="finger-indicator">
        <div class="finger-dot ${up ? "up" : ""}"></div>
        <span>${fingerNames[i]}</span>
      </div>`).join("");

    const tips = (sign.tips ?? []).map(t => `<li>${t}</li>`).join("");

    this.modal.innerHTML = `
      <div class="sign-modal-content">
        <button class="modal-close" id="modal-close">✕</button>
        <div style="display:flex; gap:1.25rem; align-items:flex-start; margin-bottom:1rem;">
          <div class="modal-photo-wrap">
            ${imgPath
              ? `<img src="${imgPath}" alt="Seña ${sign.id}" class="modal-sign-img"/>`
              : `<span style="font-family:'Martian Mono',monospace;font-size:3rem;font-weight:900;color:#fff;">${sign.id}</span>`
            }
          </div>
          <div style="flex:1">
            <h2 style="font-family:'Martian Mono',monospace;font-size:1.5rem;font-weight:800;color:var(--blue-dark);margin:0 0 0.2rem;">${sign.id}</h2>
            <div style="font-family:'Martian Mono',monospace;font-size:0.82rem;font-weight:600;color:var(--text-dark);">${sign.name ?? ""}</div>
            <div style="font-family:'Martian Mono',monospace;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-top:0.2rem;">${sign.category ?? ""}</div>
          </div>
        </div>
        ${sign.description ? `<p style="font-family:'Martian Mono',monospace;font-size:0.78rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6;">${sign.description}</p>` : ""}
        ${fingerDots ? `
          <div style="font-family:'Martian Mono',monospace;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:0.5rem;">Estado de Dedos</div>
          <div class="modal-finger-viz">${fingerDots}</div>` : ""}
        ${tips ? `
          <div style="font-family:'Martian Mono',monospace;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin:1rem 0 0.3rem;">Consejos</div>
          <ul class="tips-list">${tips}</ul>` : ""}
        <div style="margin-top:1.25rem;">
          <button class="btn btn-dark" id="modal-practice-btn" style="width:100%;">Practicar esta Seña</button>
        </div>
      </div>`;

    this.modal.style.display = "flex";
    document.getElementById("modal-close")?.addEventListener("click", () => this._closeModal());
    this.modal.addEventListener("click", e => { if (e.target === this.modal) this._closeModal(); });
    document.getElementById("modal-practice-btn")?.addEventListener("click", () => {
      this._closeModal();
      window.App?.navigateTo("practice", { signs: [sign] });
    });
  }

  _closeModal() {
    if (this.modal) this.modal.style.display = "none";
  }
}

window.LearnMode = LearnMode;
window.getSignImagePath = getSignImagePath;
