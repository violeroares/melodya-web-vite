
/**
 * MELODYA WEB — Biblioteca (6 pestañas): canciones, proyectos, letras,
 * letristas, samples y voces. Cada pestaña maneja su propia data.
 * Rutas: /library[/canciones|/proyectos|/letras|/letristas|/samples|/voces|/trash]
 */
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { LIBRARY_TABS, useLibraryTab } from './library-utils';
import { SongsTab } from './SongsTab';
import { ProjectsTab } from './ProjectsTab';
import { LyricsTab } from './LyricsTab';
import { SongwritersTab } from './SongwritersTab';
import { SamplesTab } from './SamplesTab';
import { VoicesTab } from './VoicesTab';
import { TrashTab } from './TrashTab';

export function LibraryView() {
  const [tab, setTab] = useLibraryTab();

  return (
    <div className="view-in">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">Tu biblioteca</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Todo lo que venís creando: canciones, proyectos, letras, letristas y tus sonidos.
        </p>
      </header>

      {/* Barra de pestañas: grupo segmentado (mismo componente `seg fill` del mockup letra-input), scrollable en mobile */}
      <SegmentedTabs tabs={LIBRARY_TABS} value={tab} onChange={setTab} ariaLabel="Secciones de la biblioteca" className="mb-6" />

      <div key={tab}>
        {tab === 'songs' && <SongsTab />}
        {tab === 'projects' && <ProjectsTab />}
        {tab === 'lyrics' && <LyricsTab />}
        {tab === 'lyric-personas' && <SongwritersTab />}
        {tab === 'samples' && <SamplesTab />}
        {tab === 'voices' && <VoicesTab />}
        {tab === 'trash' && <TrashTab />}
      </div>
    </div>
  );
}

export default LibraryView;