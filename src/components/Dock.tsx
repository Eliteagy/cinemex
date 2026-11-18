// The workspace of each page as dockable panels, like Premiere Pro's: every panel (Média, Visor,
// Inspetor, Timeline…) can be resized by dragging the border between two panels, and moved by
// dragging its tab onto another panel (left, right, above, below, or in the middle to stack them
// as tabs) or out of the grid as a floating window. Each page keeps its own arrangement, saved
// on this computer; "Repor painéis" puts the page back as it came.
// The docking itself is dockview (MIT); the look is Cinemex's (see .dock in styles.css).
import { Component, createContext, useContext, useMemo, useRef, type FunctionComponent, type ReactNode } from 'react';
import { DockviewReact, themeAbyssSpaced, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { Page } from '../store';
import { MediaBin } from './MediaBin';
import { Viewer } from './Viewer';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { ColorLooks, ColorPanel } from './Color';
import { ShortsPanel } from './Shorts';
import { FusionInspector, FusionLibrary, NodeEditor } from './Fusion';
import { CaptionList, CaptionStylePanel } from './Captions';
import { DeliverQueue, DeliverSettings, type DoneExport } from './Deliver';

/** Finished exports of the Entregar page: its two panels live in different places of the dock. */
export const DeliverContext = createContext<{ done: DoneExport[]; add: (d: DoneExport) => void }>({ done: [], add: () => {} });

type PanelId = 'media' | 'viewer' | 'inspector' | 'timeline' | 'fusionLib' | 'fusionInspector' | 'nodes' | 'colorLooks' | 'colorPanel' | 'captionList' | 'captionStyle' | 'deliverSettings' | 'deliverQueue' | 'shorts';

function DeliverSettingsPanel() {
  const { add } = useContext(DeliverContext);
  return <DeliverSettings onDone={add} />;
}
function DeliverQueuePanel() {
  const { done } = useContext(DeliverContext);
  return <DeliverQueue items={done} />;
}

const PANELS: Record<PanelId, { title: string; render: () => ReactNode }> = {
  media: { title: 'Média', render: () => <MediaBin /> },
  viewer: { title: 'Visor', render: () => <Viewer /> },
  inspector: { title: 'Inspetor', render: () => <Inspector /> },
  timeline: { title: 'Timeline', render: () => <Timeline /> },
  fusionLib: { title: 'Nós', render: () => <FusionLibrary /> },
  fusionInspector: { title: 'Inspetor do nó', render: () => <FusionInspector /> },
  nodes: { title: 'Editor de nós', render: () => <NodeEditor /> },
  colorLooks: { title: 'Histograma e predefinições', render: () => <ColorLooks /> },
  colorPanel: { title: 'Cor', render: () => <ColorPanel /> },
  captionList: { title: 'Legendas', render: () => <CaptionList /> },
  captionStyle: { title: 'Estilo das legendas', render: () => <CaptionStylePanel /> },
  deliverSettings: { title: 'Definições de exportação', render: () => <DeliverSettingsPanel /> },
  deliverQueue: { title: 'Exportações', render: () => <DeliverQueuePanel /> },
  shorts: { title: 'Shorts e IA', render: () => <ShortsPanel /> },
};

/** How each page comes: a panel on the left, the viewer, a panel on the right and one across the bottom. */
const LAYOUTS: Record<Page, { left: PanelId; leftW: number; right?: PanelId; rightW?: number; bottom?: PanelId }> = {
  media: { left: 'media', leftW: 560, right: 'shorts', rightW: 420 },
  edit: { left: 'media', leftW: 300, right: 'inspector', rightW: 400, bottom: 'timeline' },
  fusion: { left: 'fusionLib', leftW: 300, right: 'fusionInspector', rightW: 320, bottom: 'nodes' },
  color: { left: 'colorLooks', leftW: 300, right: 'colorPanel', rightW: 540, bottom: 'timeline' },
  captions: { left: 'captionList', leftW: 340, right: 'captionStyle', rightW: 320, bottom: 'timeline' },
  deliver: { left: 'deliverSettings', leftW: 300, right: 'deliverQueue', rightW: 320, bottom: 'timeline' },
};
const BOTTOM_H = 300;

const panelsOf = (page: Page): PanelId[] => {
  const l = LAYOUTS[page];
  return ['viewer', l.left, ...(l.right ? [l.right] : []), ...(l.bottom ? [l.bottom] : [])];
};
// The colour page (Lightroom-style panel) and the media page (Shorts e IA) changed in v2: their old saved arrangements are ignored.
const storeKey = (page: Page) => `cinemex.dock.${page === 'color' || page === 'media' ? 'v2' : 'v1'}.${page}`;

/** Forgets the saved arrangement of a page (the dock must be mounted again to show the default). */
export function resetDock(page: Page) {
  try {
    localStorage.removeItem(storeKey(page));
  } catch {
    /* storage not available: nothing was saved either */
  }
}

function buildDefault(api: DockviewApi, page: Page) {
  const l = LAYOUTS[page];
  const add = (id: PanelId, rest: object = {}) => api.addPanel({ id, component: id, title: PANELS[id].title, ...rest });
  add('viewer');
  // The bottom panel first, while the viewer is alone: it then spans the whole width.
  if (l.bottom) add(l.bottom, { position: { direction: 'below' }, initialHeight: BOTTOM_H });
  add(l.left, { position: { referencePanel: 'viewer', direction: 'left' }, initialWidth: l.leftW });
  if (l.right) add(l.right, { position: { referencePanel: 'viewer', direction: 'right' }, initialWidth: l.rightW });
  api.getPanel('viewer')?.api.setActive();
}

/** A saved arrangement is only used when it has exactly this page's panels (a new version may add or drop one). */
function restore(api: DockviewApi, page: Page): boolean {
  try {
    const raw = localStorage.getItem(storeKey(page));
    if (!raw) return false;
    const saved = JSON.parse(raw);
    const ids = Object.keys(saved?.panels ?? {}).sort();
    const want = panelsOf(page).sort();
    if (ids.length !== want.length || ids.some((id, i) => id !== want[i])) return false;
    api.fromJSON(saved);
    // A layout saved while the page was broken can come back with groups and no panels: start again.
    if (api.panels.length !== want.length) {
      api.clear();
      return false;
    }
    return true;
  } catch {
    api.clear();
    return false;
  }
}

/** One panel failing must not take the others (or the saved arrangement) with it. */
class PanelGuard extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel dock-error" role="alert">
        <strong>O painel {this.props.name} teve um erro.</strong>
        <span>{this.state.error.message}</span>
        <button className="btn sm" onClick={() => this.setState({ error: null })}>
          Tentar outra vez
        </button>
      </div>
    );
  }
}

/** The tab of a panel: its name only (panels are moved and stacked, never closed). */
function Tab(props: IDockviewPanelHeaderProps) {
  return <div className="dock-tab">{props.api.title}</div>;
}

export function Dock({ page }: { page: Page }) {
  const timer = useRef<number | undefined>(undefined);
  const components = useMemo(() => {
    const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
    for (const id of Object.keys(PANELS) as PanelId[]) {
      const Panel = () => (
        <div className="dock-fill" data-panel={id}>
          <PanelGuard name={PANELS[id].title}>{PANELS[id].render()}</PanelGuard>
        </div>
      );
      Panel.displayName = `Dock(${id})`;
      out[id] = Panel;
    }
    return out;
  }, []);
  const onReady = (e: DockviewReadyEvent) => {
    const api = e.api;
    if (!restore(api, page)) buildDefault(api, page);
    for (const p of api.panels) p.group.api.setConstraints({ minimumWidth: 200, minimumHeight: 120 });
    api.onDidLayoutChange(() => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // Never keep an arrangement that lost panels.
        if (api.panels.length !== panelsOf(page).length) return;
        try {
          localStorage.setItem(storeKey(page), JSON.stringify(api.toJSON()));
        } catch {
          /* storage full or not available: the arrangement just is not kept */
        }
      }, 300);
    });
  };
  return (
    <main className="dock" aria-label="Painéis">
      <DockviewReact components={components} defaultTabComponent={Tab} onReady={onReady} theme={{ ...themeAbyssSpaced, gap: 8 }} singleTabMode="fullwidth" floatingGroupBounds="boundedWithinViewport" dndStrategy="pointer" />
    </main>
  );
}
