import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DropZone from "../components/upload/DropZone";
import YouTubeImport from "../components/upload/YouTubeImport";
import StemPicker, { DEFAULT_STEMS } from "../components/upload/StemPicker";
import RecordingOffsetControl from "../components/recording/RecordingOffsetControl";
import YouTubeCookiesControl from "../components/settings/YouTubeCookiesControl";
import type { Folder, Song, StemName } from "../lib/types";
import { useLibraryStore } from "../stores/library";
import { useSettingsStore } from "../stores/settings";

interface LibraryPageProps {
  onSelectSong: (songId: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const ROOT_CONTAINER_ID = "root";
const FOLDER_DRAG_PREFIX = "folder:";

function sortByIndex<T extends { sortIndex: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sortIndex - b.sortIndex);
}

// `closestCenter` compares rect *centers*, so a short/empty folder next to a
// tall song list frequently loses to a nearby list row even when the pointer
// is squarely over the folder — the drop then silently resolves to the wrong
// container (or nothing moves at all). Resolve by what's actually under the
// pointer instead, falling back to rect overlap only when nothing is
// directly under it (e.g. a fast drag between two containers).
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

interface SongCardProps {
  song: Song;
  onSelect: () => void;
  onDelete: () => void;
}

function SongCard({ song, onSelect, onDelete }: SongCardProps) {
  return (
    <div
      className="song-card"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="song-card__info">
        <div className="song-card__title">{song.title}</div>
        <div className="song-card__meta">
          {song.detectedBpm && <span>{Math.round(song.detectedBpm)} BPM</span>}
          {song.detectedKey && <span>{song.detectedKey}</span>}
          <span>{formatDuration(song.duration)}</span>
          {song.stems.length > 0 && (
            <span>{song.stems.length} stems</span>
          )}
        </div>
      </div>
      <div
        className="song-card__actions"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="song-card__delete"
          onClick={onDelete}
          title="Delete song"
          aria-label="Delete song"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

function DraggableSongRow({ song, onSelect, onDelete }: SongCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: song.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="library-page__song-row">
      <button
        className="library-page__drag-handle"
        {...attributes}
        {...listeners}
        title="Drag to reorder or move to a folder"
        aria-label="Drag to reorder or move to a folder"
      >
        ⠿
      </button>
      <SongCard song={song} onSelect={onSelect} onDelete={onDelete} />
    </div>
  );
}

interface FolderSectionProps {
  folder: Folder;
  songs: Song[];
  onSelectSong: (songId: string) => void;
  onDeleteSong: (songId: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
}

function FolderSection({
  folder,
  songs,
  onSelectSong,
  onDeleteSong,
  onRenameFolder,
  onDeleteFolder,
}: FolderSectionProps) {
  const collapsed = useSettingsStore((s) => s.collapsedFolders[folder.id] ?? false);
  const setFolderCollapsed = useSettingsStore((s) => s.setFolderCollapsed);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(folder.name);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `${FOLDER_DRAG_PREFIX}${folder.id}` });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: folder.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const startEditingName = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameValue(folder.name);
    setIsEditingName(true);
  };

  const commitName = () => {
    setIsEditingName(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== folder.name) onRenameFolder(folder.id, trimmed);
  };

  return (
    <div ref={setSortableRef} style={style} className="library-page__folder">
      <div className="library-page__folder-header">
        <button
          className="library-page__drag-handle"
          {...attributes}
          {...listeners}
          title="Drag to reorder folder"
          aria-label="Drag to reorder folder"
        >
          ⠿
        </button>
        <button
          className="library-page__folder-toggle"
          onClick={() => setFolderCollapsed(folder.id, !collapsed)}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        {isEditingName ? (
          <input
            className="library-page__folder-name-input"
            value={nameValue}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              else if (e.key === "Escape") setIsEditingName(false);
            }}
          />
        ) : (
          <span
            className="library-page__folder-name"
            onDoubleClick={startEditingName}
            title="Double-click to rename"
          >
            {folder.name}
          </span>
        )}
        <span className="library-page__folder-count">{songs.length}</span>
        <button
          className="library-page__folder-rename"
          onClick={startEditingName}
          title="Rename folder"
          aria-label="Rename folder"
        >
          &#9998;
        </button>
        <button
          className="library-page__folder-delete"
          onClick={() => onDeleteFolder(folder.id)}
          title="Delete folder (songs move back to the library)"
        >
          &times;
        </button>
      </div>
      {!collapsed && (
        <div
          ref={setDroppableRef}
          className={`library-page__folder-body${isOver ? " library-page__folder-body--over" : ""}`}
        >
          <SortableContext items={songs.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {songs.length === 0 ? (
              <p className="library-page__folder-empty">Drag songs here</p>
            ) : (
              songs.map((song) => (
                <DraggableSongRow
                  key={song.id}
                  song={song}
                  onSelect={() => onSelectSong(song.id)}
                  onDelete={() => onDeleteSong(song.id)}
                />
              ))
            )}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

function RootDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: ROOT_CONTAINER_ID });
  return (
    <div
      ref={setNodeRef}
      className={`library-page__root-list${isOver ? " library-page__root-list--over" : ""}`}
    >
      {children}
    </div>
  );
}

function LibraryPage({ onSelectSong }: LibraryPageProps) {
  const songs               = useLibraryStore((s) => s.songs);
  const folders             = useLibraryStore((s) => s.folders);
  const isLoading           = useLibraryStore((s) => s.isLoading);
  const error               = useLibraryStore((s) => s.error);
  const fetchSongs          = useLibraryStore((s) => s.fetchSongs);
  const fetchFolders        = useLibraryStore((s) => s.fetchFolders);
  const deleteSong          = useLibraryStore((s) => s.deleteSong);
  const createFolder        = useLibraryStore((s) => s.createFolder);
  const renameFolder        = useLibraryStore((s) => s.renameFolder);
  const deleteFolder        = useLibraryStore((s) => s.deleteFolder);
  const reorderFolders      = useLibraryStore((s) => s.reorderFolders);
  const moveSongs           = useLibraryStore((s) => s.moveSongs);
  const clearError          = useLibraryStore((s) => s.clearError);
  const initProgressListener = useLibraryStore((s) => s.initProgressListener);
  const isProcessing = useLibraryStore((s) => s.processing !== null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [stems, setStems] = useState<StemName[]>(DEFAULT_STEMS);
  const [highQuality, setHighQuality] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    fetchSongs();
    fetchFolders();
    const cleanupPromise = initProgressListener();
    getVersion()
      .then(setAppVersion)
      .catch((e: unknown) => console.warn("[About] getVersion failed:", e));
    return () => {
      cleanupPromise.then((unlisten) => unlisten());
    };
  }, []);

  const sortedFolders = sortByIndex(folders);
  const rootSongs = sortByIndex(songs.filter((s) => !s.folderId));
  const songsByFolder = new Map<string, Song[]>();
  for (const folder of sortedFolders) {
    songsByFolder.set(folder.id, sortByIndex(songs.filter((s) => s.folderId === folder.id)));
  }

  const knownFolderIds = new Set(sortedFolders.map((f) => f.id));

  function findSongContainer(songId: string): string | null {
    if (rootSongs.some((s) => s.id === songId)) return ROOT_CONTAINER_ID;
    for (const [folderId, list] of songsByFolder) {
      if (list.some((s) => s.id === songId)) return folderId;
    }
    return null;
  }

  function containerItems(containerId: string): string[] {
    if (containerId === ROOT_CONTAINER_ID) return rootSongs.map((s) => s.id);
    return (songsByFolder.get(containerId) ?? []).map((s) => s.id);
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    if (activeId.startsWith(FOLDER_DRAG_PREFIX)) {
      const folderOrder = sortedFolders.map((f) => `${FOLDER_DRAG_PREFIX}${f.id}`);
      const oldIndex = folderOrder.indexOf(activeId);
      const newIndex = folderOrder.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(folderOrder, oldIndex, newIndex).map((id) =>
        id.slice(FOLDER_DRAG_PREFIX.length),
      );
      reorderFolders(reordered);
      return;
    }

    const fromContainer = findSongContainer(activeId);
    if (!fromContainer) return;
    const toContainer =
      overId === ROOT_CONTAINER_ID || knownFolderIds.has(overId) ? overId : findSongContainer(overId);
    if (!toContainer) return;

    const fromItems = containerItems(fromContainer);
    const toItems = containerItems(toContainer);

    let newToItems: string[];
    if (fromContainer === toContainer) {
      const oldIndex = fromItems.indexOf(activeId);
      const newIndex = toItems.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      newToItems = arrayMove(toItems, oldIndex, newIndex);
    } else {
      const overIndex = toItems.indexOf(overId);
      const insertAt = overIndex === -1 ? toItems.length : overIndex;
      newToItems = [...toItems];
      newToItems.splice(insertAt, 0, activeId);
    }

    moveSongs(toContainer === ROOT_CONTAINER_ID ? null : toContainer, newToItems);
  };

  const commitNewFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) createFolder(trimmed);
    setNewFolderName("");
    setIsCreatingFolder(false);
  };

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1>Song Practice Studio</h1>
        <div className="library-page__header-actions">
          <button
            className={`library-page__settings-btn${showSettings ? " library-page__settings-btn--active" : ""}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Recording settings"
            aria-label="Recording settings"
            aria-expanded={showSettings}
          >
            ⚙
          </button>
          <button
            className="library-page__about-btn"
            onClick={() => setShowAbout(true)}
            title="About"
            aria-label="About"
          >
            ⓘ
          </button>
        </div>
      </header>

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="about-modal__title">Song Practice Studio</h2>
            {appVersion && <p className="about-modal__version">v{appVersion}</p>}
            <p className="about-modal__desc">
              Desktop app for musicians: drop any audio file or paste a YouTube URL,
              split it into up to six instrument stems with Demucs, then mix, loop,
              slow down, and record a take alongside the separated tracks.
            </p>
            <button className="about-modal__close" onClick={() => setShowAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="library-page__import">
        <StemPicker
          value={stems}
          onChange={setStems}
          highQuality={highQuality}
          onHighQualityChange={setHighQuality}
          disabled={isProcessing}
        />
        <div className="library-page__import-sources">
          <DropZone stems={stems} highQuality={highQuality} />
          <YouTubeImport stems={stems} highQuality={highQuality} />
        </div>
      </div>

      {showSettings && (
        <div className="library-page__settings">
          <YouTubeCookiesControl />
          <RecordingOffsetControl />
        </div>
      )}

      {error && (
        <div className="library-page__error" role="alert">
          <span className="library-page__error-msg">{error}</span>
          <button
            className="library-page__error-close"
            onClick={clearError}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      {!isLoading && (songs.length > 0 || sortedFolders.length > 0) && (
        <div className="library-page__list-toolbar">
          <span className="library-page__list-toolbar-label">Library</span>
          {isCreatingFolder ? (
            <input
              className="library-page__new-folder-input"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={commitNewFolder}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewFolder();
                else if (e.key === "Escape") {
                  setNewFolderName("");
                  setIsCreatingFolder(false);
                }
              }}
              placeholder="Folder name"
            />
          ) : (
            <button className="library-page__new-folder-btn" onClick={() => setIsCreatingFolder(true)}>
              + New Folder
            </button>
          )}
        </div>
      )}

      {isLoading && <p className="library-page__loading" role="status">Loading…</p>}

      {!isLoading && songs.length === 0 && sortedFolders.length === 0 && (
        <p className="library-page__empty">
          No songs yet. Drop an audio file or paste a YouTube URL to get started.
        </p>
      )}

      {!isLoading && (songs.length > 0 || sortedFolders.length > 0) && (
        <DndContext sensors={sensors} collisionDetection={collisionDetectionStrategy} onDragEnd={handleDragEnd}>
          <div className="library-page__scroll">
            {sortedFolders.length > 0 && (
              <div className="library-page__folders">
                <SortableContext
                  items={sortedFolders.map((f) => `${FOLDER_DRAG_PREFIX}${f.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {sortedFolders.map((folder) => (
                    <FolderSection
                      key={folder.id}
                      folder={folder}
                      songs={songsByFolder.get(folder.id) ?? []}
                      onSelectSong={onSelectSong}
                      onDeleteSong={deleteSong}
                      onRenameFolder={renameFolder}
                      onDeleteFolder={deleteFolder}
                    />
                  ))}
                </SortableContext>
              </div>
            )}

            <section className="library-page__list">
              <RootDropZone>
                <SortableContext items={rootSongs.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {rootSongs.map((song) => (
                    <DraggableSongRow
                      key={song.id}
                      song={song}
                      onSelect={() => onSelectSong(song.id)}
                      onDelete={() => deleteSong(song.id)}
                    />
                  ))}
                </SortableContext>
              </RootDropZone>
            </section>
          </div>
        </DndContext>
      )}
    </div>
  );
}

export default LibraryPage;
