import {
	App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl,
} from "obsidian";

interface ABSSettings {
	serverUrl: string;
	token: string;
	booksFolder: string;
	templatePath: string;
	sinceDate: string;          // only consider progress updated on/after this date
	readingThreshold: number;   // % progress before a book counts as Reading
	createNotes: boolean;
	intervalMinutes: number;
	newNoteMedia: string;
	hcToken: string;
	hcMaxGenres: number;
	hcExcludeGenres: string;
	hcReplacePublished: boolean;
	hcAfterSync: boolean;
}

const DEFAULTS: ABSSettings = {
	serverUrl: "",
	token: "",
	booksFolder: "Books",
	templatePath: "Templates/Book.md",
	sinceDate: "2026-01-01",
	readingThreshold: 2,
	createNotes: true,
	intervalMinutes: 30,
	newNoteMedia: "AudioBook",
	hcToken: "",
	hcMaxGenres: 3,
	hcExcludeGenres: "Fiction, Audiobook, Audiobooks",
	hcReplacePublished: true,
	hcAfterSync: true,
};

const HC_URL = "https://api.hardcover.app/v1/graphql";
const HC_SEARCH = `query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 5, page: 1) { results } }`;
const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));

// Device-local flag (not synced) so only one device runs auto-sync.
const LS_AUTO = "abs-reading-sync-auto";

interface Progress {
	libraryItemId: string;
	episodeId?: string;
	mediaItemType?: string;
	progress: number;
	isFinished: boolean;
	startedAt?: number;
	finishedAt?: number;
	lastUpdate?: number;
}

interface Meta {
	title: string;
	author: string;
	narrator: string;
	series: string;
	seriesIndex: string;
	published: string;
	length: number | null;
	isbn: string;
}

type Action = { kind: "create" | "update" | "link"; title: string; path: string; changes: Record<string, unknown> };

const ymd = (ms?: number) => {
	if (!ms) return "";
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const norm = (t: string) =>
	t.toLowerCase().replace(/^\d+\s+/, "").replace(/^(a|an|the)\s+/, "").replace(/[^a-z0-9]/g, "");
const cleanTitle = (t: string) => t.replace(/^\d+\s+/, "").trim();
const safeName = (t: string) => t.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export default class ABSReadingSync extends Plugin {
	settings!: ABSSettings;
	private timer: number | null = null;
	private running = false;

	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.addSettingTab(new ABSSettingTab(this.app, this));

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(false) });
		this.addCommand({ id: "preview-sync", name: "Preview sync (writes report, changes nothing)", callback: () => this.sync(true) });

		this.addCommand({ id: "enrich", name: "Enrich book notes from Hardcover", callback: () => this.enrich(false) });
		this.addCommand({ id: "preview-enrich", name: "Preview Hardcover enrich (writes report, changes nothing)", callback: () => this.enrich(true) });
		this.addCommand({ id: "enrich-current", name: "Enrich current note from Hardcover", checkCallback: (checking) => {
			const f = this.app.workspace.getActiveFile();
			if (!f || !this.bookNotes().includes(f)) return false;
			if (!checking) this.enrich(false, [f]);
			return true;
		} });
		this.addCommand({ id: "apply-template-fields", name: "Add missing template fields to all book notes", callback: () => this.applyTemplateFields() });

		this.addRibbonIcon("headphones", "Audiobookshelf: sync now", () => this.sync(false));
		this.app.workspace.onLayoutReady(() => this.schedule());
	}

	onunload() { this.clearTimer(); }

	get autoOnThisDevice(): boolean { return this.app.loadLocalStorage(LS_AUTO) === "1"; }
	set autoOnThisDevice(v: boolean) { this.app.saveLocalStorage(LS_AUTO, v ? "1" : null); this.schedule(); }

	clearTimer() { if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; } }

	schedule() {
		this.clearTimer();
		if (!this.autoOnThisDevice || this.settings.intervalMinutes <= 0) return;
		this.timer = window.setInterval(() => this.sync(false, true), this.settings.intervalMinutes * 60_000);
		this.registerInterval(this.timer);
		window.setTimeout(() => this.sync(false, true), 10_000);
	}

	async saveSettings() { await this.saveData(this.settings); this.schedule(); }

	private async api<T>(path: string): Promise<T> {
		const base = this.settings.serverUrl.replace(/\/+$/, "");
		const r = await requestUrl({ url: base + path, headers: { Authorization: `Bearer ${this.settings.token}` } });
		return r.json as T;
	}

	private async meta(id: string): Promise<Meta> {
		const item: any = await this.api(`/api/items/${id}?expanded=1`);
		const media = item.media ?? {};
		const m = media.metadata ?? {};
		const s = (m.series ?? [])[0] ?? {};
		const names = (l: any[] | undefined) => (l ?? []).map((x: any) => (typeof x === "string" ? x : x.name)).join(", ");
		return {
			title: cleanTitle(m.title ?? ""),
			author: names(m.authors) || m.authorName || "",
			narrator: names(m.narrators) || m.narratorName || "",
			series: s.name ?? "",
			seriesIndex: s.sequence ?? "",
			published: m.publishedYear && m.publishedYear !== "0" ? String(m.publishedYear) : "",
			length: media.duration ? Math.round((media.duration / 3600) * 10) / 10 : null,
			isbn: m.isbn ?? "",
		};
	}

	private bookNotes(): TFile[] {
		const folder = normalizePath(this.settings.booksFolder) + "/";
		return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder));
	}

	async sync(dryRun: boolean, quiet = false) {
		if (this.running) return;
		if (!this.settings.serverUrl || !this.settings.token) {
			new Notice("Audiobookshelf: set server URL and API token in settings.");
			return;
		}
		this.running = true;
		const actions: Action[] = [];
		const errors: string[] = [];
		const createdFiles: TFile[] = [];
		try {
			const me: any = await this.api("/api/me");
			const since = this.settings.sinceDate ? new Date(this.settings.sinceDate + "T00:00:00").getTime() : 0;
			const progress: Progress[] = (me.mediaProgress ?? []).filter((p: Progress) =>
				!p.episodeId && p.mediaItemType !== "podcastEpisode" && (p.lastUpdate ?? 0) >= since);

			// Index existing notes by abs_id and by normalized title (unlinked only).
			const byId = new Map<string, TFile>();
			const byTitle = new Map<string, TFile>();
			for (const f of this.bookNotes()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
				if (fm.abs_id) byId.set(String(fm.abs_id), f);
				else byTitle.set(norm(f.basename), f);
			}

			const pct = (p: Progress) => Math.round((p.progress ?? 0) * 100);
			const metaCache = new Map<string, Meta>();
			const getMeta = async (id: string) => {
				if (!metaCache.has(id)) metaCache.set(id, await this.meta(id));
				return metaCache.get(id)!;
			};

			for (const p of progress) {
				const percent = p.isFinished ? 100 : pct(p);
				const active = p.isFinished || percent >= this.settings.readingThreshold;
				try {
					let file = byId.get(p.libraryItemId);
					let linking = false;
					let meta: Meta | undefined;

					if (!file) {
						meta = await getMeta(p.libraryItemId);
						const hit = byTitle.get(norm(meta.title));
						if (hit) { file = hit; linking = true; byTitle.delete(norm(meta.title)); }
					}

					if (!file) {
						if (!active || !this.settings.createNotes) continue;
						meta = meta ?? await getMeta(p.libraryItemId);
						const path = normalizePath(`${this.settings.booksFolder}/${safeName(meta.title) || p.libraryItemId}.md`);
						const fm = this.newFrontmatter(p, meta, percent);
						actions.push({ kind: "create", title: meta.title, path, changes: fm });
						if (!dryRun) {
							const created = await this.createNote(path);
							await this.app.fileManager.processFrontMatter(created, (f) => Object.assign(f, fm));
							createdFiles.push(created);
						}
						continue;
					}

					// Existing note: compute changes against current frontmatter.
					const cur = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
					const changes: Record<string, unknown> = {};
					if (linking) changes.abs_id = p.libraryItemId;

					// Status: never downgrade Finished/DNF; never auto-set To-Read.
					const st = String(cur.status ?? "");
					if (p.isFinished && st !== "Finished" && st !== "DNF") changes.status = "Finished";
					else if (!p.isFinished && active && (st === "" || st === "To-Read")) changes.status = "Reading";

					const relisten = st === "Finished" && !p.isFinished;
					if (!relisten && cur.progress !== percent && (active || !blank(cur.progress))) changes.progress = percent;
					if (blank(cur.started) && p.startedAt) changes.started = ymd(p.startedAt);
					if (blank(cur.finished) && p.isFinished && p.finishedAt) changes.finished = ymd(p.finishedAt);

					// Fill-if-blank metadata (only fetch if something is missing).
					const fill: [string, keyof Meta][] = [
						["author", "author"], ["narrator", "narrator"], ["series", "series"],
						["series_index", "seriesIndex"], ["published", "published"], ["length", "length"], ["isbn", "isbn"],
					];
					if (fill.some(([k]) => blank(cur[k]))) {
						meta = meta ?? await getMeta(p.libraryItemId);
						for (const [k, mk] of fill) {
							const v = meta[mk];
							if (blank(cur[k]) && !blank(v)) changes[k] = k === "series_index" && !isNaN(Number(v)) ? Number(v) : v;
						}
					}
					if (blank(cur.source)) changes.source = "Audiobookshelf";

					if (Object.keys(changes).length === 0) continue;
					actions.push({ kind: linking ? "link" : "update", title: file.basename, path: file.path, changes });
					if (!dryRun) await this.app.fileManager.processFrontMatter(file, (f) => Object.assign(f, changes));
				} catch (e) {
					errors.push(`${p.libraryItemId}: ${(e as Error).message}`);
				}
			}
		} catch (e) {
			errors.push(`ABS request failed: ${(e as Error).message}`);
		} finally {
			this.running = false;
		}

		if (dryRun) await this.writeReport(actions, errors);
		const n = (k: Action["kind"]) => actions.filter(a => a.kind === k).length;
		const summary = `Audiobookshelf${dryRun ? " preview" : ""}: ${n("create")} new, ${n("link")} linked, ${n("update")} updated` +
			(errors.length ? `, ${errors.length} errors` : "");
		if (!quiet || actions.length || errors.length) new Notice(summary);
		if (errors.length) console.error("[abs-reading-sync]", errors);
		if (!dryRun && createdFiles.length && this.settings.hcAfterSync && this.settings.hcToken) {
			await sleep(1500); // let metadata cache index new frontmatter
			await this.enrich(false, createdFiles, true);
		}
	}

	// ---------- Hardcover enrichment ----------

	private async hcSearch(q: string): Promise<any[]> {
		const token = this.settings.hcToken.replace(/^bearer\s+/i, "").trim();
		for (let attempt = 0; attempt < 3; attempt++) {
			const r = await requestUrl({
				url: HC_URL, method: "POST", throw: false,
				contentType: "application/json",
				headers: { authorization: `Bearer ${token}`, "user-agent": "obsidian-abs-reading-sync" },
				body: JSON.stringify({ query: HC_SEARCH, variables: { q } }),
			});
			if (r.status === 429) { await sleep(((Number(r.headers["retry-after"]) || 5) * 1000)); continue; }
			if (r.status >= 400) throw new Error(`Hardcover HTTP ${r.status}`);
			const j = r.json;
			if (j.errors?.length) throw new Error(`Hardcover: ${j.errors[0].message}`);
			let res = j.data?.search?.results;
			if (typeof res === "string") res = JSON.parse(res);
			return (res?.hits ?? []).map((h: any) => h.document ?? h);
		}
		throw new Error("Hardcover rate limit");
	}

	private pickHit(hits: any[], title: string, author: string): any | null {
		const nt = norm(title);
		const last = norm((author.split(",")[0] ?? "").trim().split(/\s+/).pop() ?? "");
		const authorOk = (d: any) => !last || (d.author_names ?? []).some((a: string) => norm(a).includes(last));
		const titleOk = (d: any) => [d.title, ...(d.alternative_titles ?? [])].some((t: string) => t && norm(t) === nt);
		return hits.find(d => titleOk(d) && authorOk(d))
			?? hits.find(d => authorOk(d) && d.title && (norm(d.title).startsWith(nt) || nt.startsWith(norm(d.title))))
			?? null;
	}

	private hcChanges(cur: Record<string, any>, d: any): Record<string, unknown> {
		const ch: Record<string, unknown> = {};
		const firstLink = blank(cur.hardcover);
		const isbn = (d.isbns ?? []).find((x: string) => /^97[89]\d{10}$/.test(x)) ?? (d.isbns ?? []).find((x: string) => /^\d{9}[\dX]$/.test(x));
		if (blank(cur.isbn) && isbn) ch.isbn = isbn;
		if (blank(cur.pages) && d.pages) ch.pages = d.pages;
		if (d.release_year && (blank(cur.published) || (firstLink && this.settings.hcReplacePublished && Number(cur.published) !== d.release_year)))
			ch.published = d.release_year;
		if (blank(cur.genre) && (d.genres ?? []).length) {
			const ex = new Set(this.settings.hcExcludeGenres.split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
			const g = (d.genres as string[]).filter(x => !ex.has(x.toLowerCase())).slice(0, Math.max(1, this.settings.hcMaxGenres));
			if (g.length) ch.genre = g;
		}
		if (firstLink && d.slug) ch.hardcover = `https://hardcover.app/books/${d.slug}`;
		return ch;
	}

	private enriching = false;

	async enrich(dryRun: boolean, only?: TFile[], quiet = false) {
		if (!this.settings.hcToken) { new Notice("Hardcover: set your API token in settings."); return; }
		if (this.enriching) return;
		this.enriching = true;
		const fields = ["isbn", "pages", "published", "genre"];
		const files = (only ?? this.bookNotes()).filter(f => {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
			return fields.some(k => blank(fm[k])) || (blank(fm.hardcover) && this.settings.hcReplacePublished);
		});
		const actions: Action[] = [];
		const misses: string[] = [];
		const errors: string[] = [];
		const progress = files.length > 5 ? new Notice(`Hardcover: 0/${files.length}`, 0) : null;
		try {
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				progress?.setMessage(`Hardcover: ${i + 1}/${files.length} ${f.basename}`);
				const cur = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
				const author = String(cur.author ?? "");
				try {
					let hit = this.pickHit(await this.hcSearch(`${f.basename} ${author}`.trim()), f.basename, author);
					if (!hit) { await sleep(1100); hit = this.pickHit(await this.hcSearch(f.basename), f.basename, author); }
					if (!hit) { misses.push(`${f.basename} (${author || "no author"})`); }
					else {
						const ch = this.hcChanges(cur, hit);
						if (Object.keys(ch).length) {
							actions.push({ kind: "update", title: `${f.basename} → ${hit.title} (${(hit.author_names ?? []).join(", ")})`, path: f.path, changes: ch });
							if (!dryRun) await this.app.fileManager.processFrontMatter(f, (fm) => Object.assign(fm, ch));
						}
					}
				} catch (e) { errors.push(`${f.basename}: ${(e as Error).message}`); }
				if (i < files.length - 1) await sleep(1100); // stay under 60 req/min
			}
		} finally {
			progress?.hide();
			this.enriching = false;
		}
		if (dryRun) await this.writeEnrichReport(actions, misses, errors);
		const msg = `Hardcover${dryRun ? " preview" : ""}: ${actions.length} updated, ${misses.length} not found` + (errors.length ? `, ${errors.length} errors` : "");
		if (!quiet || actions.length || misses.length || errors.length) new Notice(msg);
		if (errors.length) console.error("[abs-reading-sync] hardcover", errors);
	}

	private async writeEnrichReport(actions: Action[], misses: string[], errors: string[]) {
		const lines = ["# Hardcover Enrich Preview", "", `Generated ${new Date().toLocaleString()}. Nothing was changed. Check that each match is the right book.`, "",
			`## Matches (${actions.length})`, ""];
		for (const a of actions) {
			const ch = Object.entries(a.changes).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ");
			lines.push(`- **${a.title}**: ${ch}`);
		}
		lines.push("", `## Not found (${misses.length})`, "", ...misses.map(m => `- ${m}`), "");
		if (errors.length) lines.push("## Errors", "", ...errors.map(e => `- ${e}`), "");
		const path = "Hardcover Enrich Preview.md";
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, lines.join("\n"));
		else await this.app.vault.create(path, lines.join("\n"));
		await this.app.workspace.openLinkText(path, "", true);
	}

	private newFrontmatter(p: Progress, m: Meta, percent: number): Record<string, unknown> {
		const fm: Record<string, unknown> = {
			author: m.author,
			series: m.series,
			series_index: m.seriesIndex && !isNaN(Number(m.seriesIndex)) ? Number(m.seriesIndex) : m.seriesIndex,
			status: p.isFinished ? "Finished" : "Reading",
			media: this.settings.newNoteMedia,
			narrator: m.narrator,
			published: m.published,
			length: m.length ?? "",
			started: ymd(p.startedAt),
			finished: p.isFinished ? ymd(p.finishedAt) : "",
			progress: percent,
			source: "Audiobookshelf",
			isbn: m.isbn,
			abs_id: p.libraryItemId,
		};
		return fm;
	}

	private async createNote(path: string): Promise<TFile> {
		let body = "";
		const tpl = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatePath));
		if (tpl instanceof TFile) body = await this.app.vault.read(tpl);
		const folder = normalizePath(this.settings.booksFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		let target = path, i = 2;
		while (this.app.vault.getAbstractFileByPath(target)) target = path.replace(/\.md$/, ` (${i++}).md`);
		return this.app.vault.create(target, body);
	}

	async applyTemplateFields() {
		const tpl = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatePath));
		if (!(tpl instanceof TFile)) { new Notice(`Template not found: ${this.settings.templatePath}`); return; }
		const tfm = this.app.metadataCache.getFileCache(tpl)?.frontmatter ?? {};
		const keys = Object.keys(tfm).filter(k => k !== "position");
		let touched = 0, added = 0;
		for (const f of this.bookNotes()) {
			const cur = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
			const missing = keys.filter(k => !(k in cur));
			if (!missing.length) continue;
			// Missing keys get the template's default (e.g. owned: false) or empty. Existing values are never changed.
			await this.app.fileManager.processFrontMatter(f, (fm) => {
				for (const k of missing) if (!(k in fm)) fm[k] = blank(tfm[k]) ? null : tfm[k];
			});
			touched++; added += missing.length;
		}
		new Notice(`Template fields: added ${added} fields across ${touched} notes.`);
	}

	private async writeReport(actions: Action[], errors: string[]) {
		const lines = [`# ABS Sync Preview`, ``, `Generated ${new Date().toLocaleString()}. Nothing was changed.`, ``];
		for (const kind of ["create", "link", "update"] as const) {
			const list = actions.filter(a => a.kind === kind);
			lines.push(`## ${kind[0].toUpperCase() + kind.slice(1)} (${list.length})`, "");
			for (const a of list) {
				const ch = Object.entries(a.changes).filter(([, v]) => !blank(v)).map(([k, v]) => `${k}: ${v}`).join("; ");
				lines.push(`- **${a.title}** (\`${a.path}\`): ${ch}`);
			}
			lines.push("");
		}
		if (errors.length) lines.push("## Errors", "", ...errors.map(e => `- ${e}`), "");
		const path = "ABS Sync Preview.md";
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, lines.join("\n"));
		else await this.app.vault.create(path, lines.join("\n"));
		await this.app.workspace.openLinkText(path, "", true);
	}
}

class ABSSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ABSReadingSync) { super(app, plugin); }

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Server URL").setDesc("e.g. https://abs.home.lan")
			.addText(t => t.setValue(s.serverUrl).onChange(v => { s.serverUrl = v.trim(); save(); }));
		new Setting(containerEl).setName("API token").setDesc("Stored in this plugin's data.json (plain text, synced if plugin settings sync).")
			.addText(t => { t.inputEl.type = "password"; t.setValue(s.token).onChange(v => { s.token = v.trim(); save(); }); });
		new Setting(containerEl).setName("Test connection")
			.addButton(b => b.setButtonText("Test").onClick(async () => {
				try {
					const base = s.serverUrl.replace(/\/+$/, "");
					const r = await requestUrl({ url: base + "/api/me", headers: { Authorization: `Bearer ${s.token}` } });
					new Notice(`Connected as ${r.json.username} (${(r.json.mediaProgress ?? []).length} progress records)`);
				} catch (e) { new Notice(`Connection failed: ${(e as Error).message}`); }
			}));
		new Setting(containerEl).setName("Books folder")
			.addText(t => t.setValue(s.booksFolder).onChange(v => { s.booksFolder = v.trim(); save(); }));
		new Setting(containerEl).setName("Template for new notes").setDesc("Its frontmatter is merged with ABS data. Leave blank for none.")
			.addText(t => t.setValue(s.templatePath).onChange(v => { s.templatePath = v.trim(); save(); }));
		new Setting(containerEl).setName("Only progress updated since").setDesc("YYYY-MM-DD. Blank for all history.")
			.addText(t => t.setValue(s.sinceDate).onChange(v => { s.sinceDate = v.trim(); save(); }));
		new Setting(containerEl).setName("Reading threshold (%)").setDesc("Progress below this is ignored for new notes and status changes.")
			.addText(t => t.setValue(String(s.readingThreshold)).onChange(v => { s.readingThreshold = Number(v) || 0; save(); }));
		new Setting(containerEl).setName("Create notes for new books")
			.addToggle(t => t.setValue(s.createNotes).onChange(v => { s.createNotes = v; save(); }));
		new Setting(containerEl).setName("Media value for new notes")
			.addText(t => t.setValue(s.newNoteMedia).onChange(v => { s.newNoteMedia = v; save(); }));
		new Setting(containerEl).setName("Auto-sync interval (minutes)").setDesc("0 disables.")
			.addText(t => t.setValue(String(s.intervalMinutes)).onChange(v => { s.intervalMinutes = Number(v) || 0; save(); }));
		new Setting(containerEl).setName("Auto-sync on this device")
			.setDesc("Device-local. Enable on one device only to avoid duplicate notes from Sync races.")
			.addToggle(t => t.setValue(this.plugin.autoOnThisDevice).onChange(v => { this.plugin.autoOnThisDevice = v; }));

		new Setting(containerEl).setName("Hardcover").setHeading();
		new Setting(containerEl).setName("Hardcover API token").setDesc("From hardcover.app/account/api. Tokens expire; set a long expiry.")
			.addText(t => { t.inputEl.type = "password"; t.setValue(s.hcToken).onChange(v => { s.hcToken = v.trim(); save(); }); });
		new Setting(containerEl).setName("Max genres per book")
			.addText(t => t.setValue(String(s.hcMaxGenres)).onChange(v => { s.hcMaxGenres = Number(v) || 3; save(); }));
		new Setting(containerEl).setName("Excluded genres").setDesc("Comma-separated, case-insensitive.")
			.addText(t => t.setValue(s.hcExcludeGenres).onChange(v => { s.hcExcludeGenres = v; save(); }));
		new Setting(containerEl).setName("Replace published year with original release year")
			.setDesc("Applies once per note, the first time it is linked to Hardcover. Later manual edits are kept.")
			.addToggle(t => t.setValue(s.hcReplacePublished).onChange(v => { s.hcReplacePublished = v; save(); }));
		new Setting(containerEl).setName("Enrich new notes after ABS sync")
			.addToggle(t => t.setValue(s.hcAfterSync).onChange(v => { s.hcAfterSync = v; save(); }));
	}
}
