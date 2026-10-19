const API_BASE = "https://api.rawg.io/api";

const nav = document.querySelector(".nav");
const navButtons = document.querySelectorAll(".nav-btn");
const gridTitle = document.querySelector("#grid-title");
const gamesGrid = document.querySelector("#games-grid");
const searchBar = document.querySelector("#search-bar");
const addButton = document.querySelector("#add-btn");

const STORAGE_KEY = "gameNoteSavedGames";

const pageTitles = {
    discover: "Discover",
    plan: "Your Plan",
    completed: "Completed"
};

let currentPage = "discover";
let currentView = "grid";
let searchTimer;
let requestNumber = 0;

/* ---------- 1. SAFE TEXT HELPERS ---------- */

function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function cleanDescription(html = "") {
    const documentCopy = new DOMParser().parseFromString(
        html,
        "text/html"
    );

    return documentCopy.body.textContent.trim();
}

/* ---------- 2. API KEY AND REQUESTS ---------- */

function getApiKey() {
    const key = window.RAWG_API_KEY;

    if (!key || key === "PASTE_YOUR_RAWG_API_KEY_HERE") {
        throw new Error(
            "Add your RAWG API key to config.js first."
        );
    }

    return key;
}

async function fetchRAWG(endpoint, params = {}) {
    const url = new URL(`${API_BASE}/${endpoint}`);

    url.searchParams.set("key", getApiKey());

    Object.entries(params).forEach(([name, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(name, value);
        }
    });

    const response = await fetch(url);

    if (response.status === 401 || response.status === 403) {
        throw new Error(
            "RAWG rejected the request. Check your API key."
        );
    }

    if (response.status === 429) {
        throw new Error(
            "RAWG request limit reached. Please try again later."
        );
    }

    if (!response.ok) {
        throw new Error(
            `RAWG request failed (${response.status}).`
        );
    }

    return response.json();
}

/* ---------- 3. LOCAL STORAGE ---------- */

function getSavedGames() {
    try {
        const saved = JSON.parse(
            localStorage.getItem(STORAGE_KEY) || "[]"
        );

        return Array.isArray(saved) ? saved : [];
    } catch {
        return [];
    }
}

function saveGames(games) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
}

function addGameToPlan(game) {
    const savedGames = getSavedGames();
    const existing = savedGames.find(
        item => String(item.id) === String(game.id)
    );

    if (existing) {
        if (existing.status === "completed") {
            existing.status = "plan";
            saveGames(savedGames);
            showNotice("Moved back to Your Plan.");
        } else {
            showNotice("This game is already in Your Plan.");
        }

        return;
    }

    savedGames.push({
        id: game.id,
        name: game.name,
        background_image: game.background_image || "",
        released: game.released || "",
        rating: game.rating || 0,
        genres: game.genres || [],
        platforms: game.platforms || [],
        status: "plan",
        addedAt: Date.now()
    });

    saveGames(savedGames);
    showNotice(`${game.name} added to Your Plan.`);
}

function changeGameStatus(id, status) {
    const savedGames = getSavedGames();

    const game = savedGames.find(
        item => String(item.id) === String(id)
    );

    if (!game) return;

    game.status = status;
    saveGames(savedGames);

    renderCurrentPage();
}

/* ---------- 4. NOTIFICATIONS ---------- */

function showNotice(message) {
    let notice = document.querySelector("#game-note-notice");

    if (!notice) {
        notice = document.createElement("div");
        notice.id = "game-note-notice";
        notice.className = "gn-notice";
        notice.setAttribute("role", "status");
        document.body.appendChild(notice);
    }

    notice.textContent = message;
    notice.classList.add("is-visible");

    clearTimeout(notice.hideTimer);

    notice.hideTimer = setTimeout(() => {
        notice.classList.remove("is-visible");
    }, 2600);
}

/* ---------- 5. LOADING AND ERROR STATES ---------- */

function showMessage(title, message, retry = false) {
    gamesGrid.innerHTML = `
        <div class="gn-message">
            <h3>${escapeHTML(title)}</h3>
            <p>${escapeHTML(message)}</p>
            ${retry ? `
                <button class="gn-button" data-action="retry">
                    Try again
                </button>
            ` : ""}
        </div>
    `;
}

function showLoading() {
    gamesGrid.innerHTML = `
        <div class="gn-loading">
            <span class="gn-spinner"></span>
            <p>Loading games...</p>
        </div>
    `;
}

/* ---------- 6. GAME CARDS ---------- */

function renderGameCards(games, mode = "discover") {
    if (!games.length) {
        showMessage(
            "Nothing here yet",
            mode === "discover"
                ? "Try another search."
                : "Games you add will appear here."
        );
        return;
    }

    gamesGrid.innerHTML = games.map(game => {
        const genres = (game.genres || [])
            .map(genre => genre.name || genre)
            .filter(Boolean)
            .slice(0, 2)
            .join(" · ");

        const platforms = (game.platforms || [])
            .map(item => item.platform?.name || item.name || item)
            .filter(Boolean)
            .slice(0, 2)
            .join(" · ");

        const image = game.background_image || "";
        const rating = Number(game.rating || 0);
        const release = game.released || "Release date unknown";

        let actionButton = "";

        if (mode === "plan") {
            actionButton = `
                <button class="gn-button"
                    data-action="complete"
                    data-id="${escapeHTML(game.id)}">
                    Mark completed
                </button>
            `;
        } else if (mode === "completed") {
            actionButton = `
                <button class="gn-button"
                    data-action="move-to-plan"
                    data-id="${escapeHTML(game.id)}">
                    Move to Plan
                </button>
            `;
        } else {
            actionButton = `
                <button class="gn-button gn-button-secondary"
                    data-action="add"
                    data-id="${escapeHTML(game.id)}">
                    + Add
                </button>
            `;
        }

        return `
            <article class="gn-game-card">
                <button class="gn-cover-button"
                    data-action="details"
                    data-id="${escapeHTML(game.id)}"
                    aria-label="View ${escapeHTML(game.name)} details">

                    ${
                        image
                            ? `<img class="gn-cover"
                                src="${escapeHTML(image)}"
                                alt="${escapeHTML(game.name)} cover"
                                loading="lazy">`
                            : `<div class="gn-cover gn-no-cover">
                                No cover available
                               </div>`
                    }
                </button>

                <div class="gn-card-content">
                    <h3>${escapeHTML(game.name)}</h3>

                    <p class="gn-muted">
                        ${escapeHTML(genres || platforms || "Video game")}
                    </p>

                    <div class="gn-card-meta">
                        <span>${escapeHTML(release)}</span>
                        <span>★ ${rating ? rating.toFixed(1) : "—"}</span>
                    </div>

                    <div class="gn-card-actions">
                        <button class="gn-button gn-button-secondary"
                            data-action="details"
                            data-id="${escapeHTML(game.id)}">
                            Details
                        </button>
                        ${actionButton}
                    </div>
                </div>
            </article>
        `;
    }).join("");
}

/* ---------- 7. DISCOVER FROM RAWG ---------- */

async function loadDiscover(query = "") {
    const thisRequest = ++requestNumber;

    currentView = "grid";
    showLoading();

    try {
        const data = await fetchRAWG("games", {
            search: query.trim() || undefined,
            page_size: 12,
            ordering: query.trim() ? "-rating" : "-added"
        });

        if (thisRequest !== requestNumber) return;

        renderGameCards(data.results || [], "discover");
    } catch (error) {
        if (thisRequest !== requestNumber) return;

        showMessage(
            "Couldn't load games",
            error.message,
            true
        );
    }
}

/* ---------- 8. GAME DETAILS ---------- */

async function openGameDetails(id) {
    const thisRequest = ++requestNumber;

    currentView = "details";
    showLoading();

    try {
        const game = await fetchRAWG(`games/${encodeURIComponent(id)}`);

        if (thisRequest !== requestNumber) return;

        const genres = (game.genres || [])
            .map(item => item.name)
            .filter(Boolean)
            .join(", ") || "Unknown";

        const platforms = (game.platforms || [])
            .map(item => item.platform?.name)
            .filter(Boolean)
            .join(", ") || "Unknown";

        const developers = (game.developers || [])
            .map(item => item.name)
            .filter(Boolean)
            .join(", ") || "Unknown";

        const publishers = (game.publishers || [])
            .map(item => item.name)
            .filter(Boolean)
            .join(", ") || "Unknown";

        const description = cleanDescription(
            game.description || ""
        );

        gamesGrid.innerHTML = `
            <section class="gn-detail">
                <button class="gn-button gn-button-secondary"
                    data-action="back">
                    ← Back
                </button>

                <div class="gn-detail-layout">
                    <div class="gn-detail-art">
                        ${
                            game.background_image
                                ? `<img src="${escapeHTML(game.background_image)}"
                                    alt="${escapeHTML(game.name)} cover">`
                                : `<div class="gn-no-cover">No cover available</div>`
                        }
                    </div>

                    <div class="gn-detail-info">
                        <p class="gn-eyebrow">GAME DETAILS</p>
                        <h2>${escapeHTML(game.name)}</h2>

                        <div class="gn-detail-rating">
                            ★ ${game.rating
                                ? Number(game.rating).toFixed(1)
                                : "Not rated"}
                            ${game.metacritic
                                ? ` · Metacritic ${escapeHTML(game.metacritic)}`
                                : ""}
                        </div>

                        <p>${escapeHTML(description ||
                            "No description is available for this game.")}</p>

                        <dl class="gn-facts">
                            <div>
                                <dt>Release date</dt>
                                <dd>${escapeHTML(game.released || "Unknown")}</dd>
                            </div>
                            <div>
                                <dt>Genres</dt>
                                <dd>${escapeHTML(genres)}</dd>
                            </div>
                            <div>
                                <dt>Platforms</dt>
                                <dd>${escapeHTML(platforms)}</dd>
                            </div>
                            <div>
                                <dt>Developer</dt>
                                <dd>${escapeHTML(developers)}</dd>
                            </div>
                            <div>
                                <dt>Publisher</dt>
                                <dd>${escapeHTML(publishers)}</dd>
                            </div>
                        </dl>

                        <button class="gn-button gn-add-detail"
                            data-action="add"
                            data-id="${escapeHTML(game.id)}">
                            + Add to Plan
                        </button>

                        <p class="gn-attribution">
                            Game information and artwork provided by
                            <a href="https://rawg.io/"
                                target="_blank"
                                rel="noopener noreferrer">RAWG</a>.
                        </p>
                    </div>
                </div>
            </section>
        `;
    } catch (error) {
        if (thisRequest !== requestNumber) return;

        showMessage("Couldn't load game details", error.message, true);
    }
}

/* ---------- 9. PLAN AND COMPLETED ---------- */

function loadSavedList(status) {
    const games = getSavedGames().filter(
        game => game.status === status
    );

    renderGameCards(
        games,
        status === "completed" ? "completed" : "plan"
    );
}

/* ---------- 10. NAVIGATION ---------- */

function updateNavigationPill() {
    if (!nav) return;

    const activeButton = nav.querySelector(".nav-btn.active");
    if (!activeButton) return;

    const navRect = nav.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();

    const x = buttonRect.left - navRect.left - nav.clientLeft;

    nav.style.setProperty("--pill-x", `${x}px`);
    nav.style.setProperty("--pill-width", `${buttonRect.width}px`);
}

function renderCurrentPage() {
    currentView = "grid";

    if (currentPage === "discover") {
        loadDiscover(searchBar?.value || "");
    } else if (currentPage === "plan") {
        loadSavedList("plan");
    } else if (currentPage === "completed") {
        loadSavedList("completed");
    }
}

function changePage(page) {
    if (!pageTitles[page]) return;

    currentPage = page;
    currentView = "grid";

    navButtons.forEach(button => {
        const active = button.dataset.page === page;

        button.classList.toggle("active", active);

        if (active) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });

    if (gridTitle) {
        gridTitle.textContent = pageTitles[page];
    }

    renderCurrentPage();
    updateNavigationPill();
}

navButtons.forEach(button => {
    button.addEventListener("click", () => {
        changePage(button.dataset.page);
    });
});

/* ---------- 11. SEARCH ---------- */

if (searchBar) {
    searchBar.addEventListener("input", () => {
        if (currentPage !== "discover") {
            changePage("discover");
        } else {
            clearTimeout(searchTimer);

            searchTimer = setTimeout(() => {
                loadDiscover(searchBar.value);
            }, 400);
        }
    });
}

/* ---------- 12. BUTTON ACTIONS ---------- */

gamesGrid.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const id = button.dataset.id;

    if (action === "retry") {
        renderCurrentPage();
        return;
    }

    if (action === "back") {
        currentView = "grid";
        renderCurrentPage();
        return;
    }

    if (action === "details") {
        await openGameDetails(id);
        return;
    }

    if (action === "add") {
        let game = getSavedGames().find(
            item => String(item.id) === String(id)
        );

        if (!game) {
            const card = button.closest(".gn-game-card");

            if (card) {
                const title = card.querySelector("h3")?.textContent || "";
                const image = card.querySelector(".gn-cover")?.src || "";

                game = {
                    id: Number(id),
                    name: title,
                    background_image: image,
                    status: "plan"
                };
            } else {
                try {
                    game = await fetchRAWG(`games/${encodeURIComponent(id)}`);
                } catch (error) {
                    showNotice(error.message);
                    return;
                }
            }
        }

        addGameToPlan(game);
        return;
    }

    if (action === "complete") {
        changeGameStatus(id, "completed");
        showNotice("Game marked as completed.");
        return;
    }

    if (action === "move-to-plan") {
        changeGameStatus(id, "plan");
        showNotice("Game moved to Your Plan.");
    }
});

/* ---------- 13. ADD GAME BUTTON ---------- */

if (addButton) {
    addButton.addEventListener("click", () => {
        changePage("plan");

        if (searchBar) {
            searchBar.focus();
            searchBar.placeholder = "Search Discover to find a game...";
        }

        showNotice(
            "Your lists are here. Search Discover to find games to add."
        );
    });
}

/* ---------- 14. INITIALIZE ---------- */

if (searchBar) {
    searchBar.value = "";
}

navButtons.forEach(button => {
    button.classList.toggle(
        "active",
        button.dataset.page === "discover"
    );
});

changePage("discover");

requestAnimationFrame(updateNavigationPill);
window.addEventListener("resize", updateNavigationPill);
