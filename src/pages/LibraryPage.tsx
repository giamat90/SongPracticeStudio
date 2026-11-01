import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  FOLDER_DRAG_PREFIX,
  ROOT_CONTAINER_ID,
  activateOnKey,
  formatDuration,
  useEditableText,
  useLibraryPage,
} from "@giamat90/mps-core/hooks";
import {
  libraryCollisionDetection,
  useLibrarySensors,
  useRootDropZone,
  useSortableFolder,
  useSortableSongRow,
} from "@giamat90/mps-core/hooks/dnd";
import DropZone from "../components/upload/DropZone";
import YouTubeImport from "../components/upload/YouTubeImport";
import ImportQueue from "../components/upload/ImportQueue";
import StemPicker, { DEFAULT_STEMS } from "../components/upload/StemPicker";
import RecordingOffsetControl from "../components/recording/RecordingOffsetControl";
import YouTubeCookiesControl from "../components/settings/YouTubeCookiesControl";
import type { Folder, Song, StemName } from "../lib/types";
import { filterSongs } from "../lib/librarySearch";
import { useLibraryStore } from "../stores/library";
import { useSettingsStore } from "../stores/settings";

interface LibraryPageProps {
  onSelectSong: (songId: string) => void;
}

interface SongCardProps {
  song: Song;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

function SongCard({ song, onSelect, onDelete, onRename }: SongCardProps) {
  const title = useEditableText(song.title, onRename);

  return (
    <div
      className="song-card"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={activateOnKey(onSelect)}
    >
      <div className="song-card__info">
        <div className="song-card__title">
          {title.editing ? (
            <input
              className="song-card__title-input"
              value={title.text}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => title.setText(e.target.value)}
              onBlur={title.commit}
              onKeyDown={title.onKeyDown}
            />
          ) : (
            <span onDoubleClick={title.start} title="Double-click to rename">
              {song.title}
            </span>
          )}
          <button
            className="song-card__rename"
            onClick={title.start}
            title="Rename song"
            aria-label="Rename song"
          >
            &#9998;
          </button>
        </div>
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

function DraggableSongRow({ song, onSelect, onDelete, onRename }: SongCardProps) {
  const { setNodeRef, style, handleProps } = useSortableSongRow(song.id);
  return (
    <div ref={setNodeRef} style={style} className="library-page__song-row">
      <button
        className="library-page__drag-handle"
        {...handleProps}
        title="Drag to reorder or move to a folder"
        aria-label="Drag to reorder or move to a folder"
      >
        ⠿
      </button>
      <SongCard song={song} onSelect={onSelect} onDelete={onDelete} onRename={onRename} />
    </div>
  );
}

interface FolderSectionProps {
  folder: Folder;
  songs: Song[];
  onSelectSong: (songId: string) => void;
  onDeleteSong: (songId: string) => void;
  onRenameSong: (songId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  isDropTarget: boolean;
}

function FolderSection({
  folder,
  songs,
  onSelectSong,
  onDeleteSong,
  onRenameSong,
  onRenameFolder,
  onDeleteFolder,
  isDropTarget,
}: FolderSectionProps) {
  const collapsed = useSettingsStore((s) => s.collapsedFolders[folder.id] ?? false);
  const setFolderCollapsed = useSettingsStore((s) => s.setFolderCollapsed);
  const name = useEditableText(folder.name, (next) => onRenameFolder(folder.id, next));
  const { setSortableRef, setDroppableRef, style, handleProps } = useSortableFolder(folder.id);

  return (
    <div
      ref={setSortableRef}
      style={style}
      className={`library-page__folder${isDropTarget ? " library-page__folder--target" : ""}`}
    >
      <div className="library-page__folder-header">
        <button
          className="library-page__drag-handle"
          {...handleProps}
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
        {name.editing ? (
          <input
            className="library-page__folder-name-input"
            value={name.text}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => name.setText(e.target.value)}
            onBlur={name.commit}
            onKeyDown={name.onKeyDown}
          />
        ) : (
          <span
            className="library-page__folder-name"
            onDoubleClick={name.start}
            title="Double-click to rename"
          >
            {folder.name}
          </span>
        )}
        <span className="library-page__folder-count">{songs.length}</span>
        <button
          className="library-page__folder-rename"
          onClick={name.start}
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
        <div ref={setDroppableRef} className="library-page__folder-body">
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
                  onRename={(title) => onRenameSong(song.id, title)}
                />
              ))
            )}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

function RootDropZone({ isDropTarget, children }: { isDropTarget: boolean; children: React.ReactNode }) {
  const { setNodeRef } = useRootDropZone();
  return (
    <div
      ref={setNodeRef}
      className={`library-page__root-list${isDropTarget ? " library-page__root-list--target" : ""}`}
    >
      {children}
    </div>
  );
}

function LibraryPage({ onSelectSong }: LibraryPageProps) {
  const {
    isLoading, error, sessionExpired, signInNeeded, hasContent, sortedFolders, rootSongs, songsByFolder,
    searching, matches, folderNameOf, deleteSong, renameSong, renameFolder, deleteFolder, clearError,
    signInAndRetryYoutube, dropTarget, handleDragOver, handleDragCancel, handleDragEnd, showAbout, openAbout, closeAbout, showSettings, toggleSettings,
    appVersion, highQuality, setHighQuality, query, setQuery, clearQuery, isCreatingFolder, startCreatingFolder,
    newFolderName, setNewFolderName, commitNewFolder, cancelNewFolder,
  } = useLibraryPage({ useStore: useLibraryStore, getVersion, filterSongs });
  const [stems, setStems] = useState<StemName[]>(DEFAULT_STEMS);
  const sensors = useLibrarySensors();

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1>Song Practice Studio</h1>
        <div className="library-page__header-actions">
          <button
            className={`library-page__settings-btn${showSettings ? " library-page__settings-btn--active" : ""}`}
            onClick={toggleSettings}
            title="Recording settings"
            aria-label="Recording settings"
            aria-expanded={showSettings}
          >
            ⚙
          </button>
          <button
            className="library-page__about-btn"
            onClick={openAbout}
            title="About"
            aria-label="About"
          >
            ⓘ
          </button>
        </div>
      </header>

      {showAbout && (
        <div className="about-overlay" onClick={closeAbout}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="about-modal__title">Song Practice Studio</h2>
            {appVersion && <p className="about-modal__version">v{appVersion}{import.meta.env.DEV ? "d" : ""}</p>}
            <p className="about-modal__desc">
              Desktop app for musicians: drop any audio file or paste a YouTube URL,
              split it into up to six instrument stems with Demucs, then mix, loop,
              slow down, and record a take alongside the separated tracks.
            </p>
            <button className="about-modal__close" onClick={closeAbout}>
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
        />
        <div className="library-page__import-sources">
          <DropZone stems={stems} highQuality={highQuality} />
          <YouTubeImport stems={stems} highQuality={highQuality} />
        </div>
        <ImportQueue />
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
          {(sessionExpired || signInNeeded) && (
            <button
              className="library-page__error-action"
              onClick={signInAndRetryYoutube}
            >
              {signInNeeded ? "Sign in to YouTube and retry" : "Sign in again and retry"}
            </button>
          )}
          <button
            className="library-page__error-close"
            onClick={clearError}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      {!isLoading && hasContent && (
        <div className="library-page__list-toolbar">
          <span className="library-page__list-toolbar-label">Library</span>
          <input
            className="library-page__search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") clearQuery();
            }}
            placeholder="Search title, key, tempo or folder"
            aria-label="Search the library"
          />
          {isCreatingFolder ? (
            <input
              className="library-page__new-folder-input"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={commitNewFolder}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewFolder();
                else if (e.key === "Escape") cancelNewFolder();
              }}
              placeholder="Folder name"
            />
          ) : (
            <button className="library-page__new-folder-btn" onClick={startCreatingFolder}>
              + New Folder
            </button>
          )}
        </div>
      )}

      {isLoading && <p className="library-page__loading" role="status">Loading…</p>}

      {!isLoading && !hasContent && (
        <p className="library-page__empty">
          No songs yet. Drop an audio file or paste a YouTube URL to get started.
        </p>
      )}

      {!isLoading && searching && (
        <div className="library-page__scroll">
          {matches.length === 0 ? (
            <p className="library-page__empty">No song matches &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <section className="library-page__list library-page__results" aria-label="Search results">
              {matches.map((song) => (
                <div key={song.id} className="library-page__result">
                  <SongCard
                    song={song}
                    onSelect={() => onSelectSong(song.id)}
                    onDelete={() => deleteSong(song.id)}
                    onRename={(title) => renameSong(song.id, title)}
                  />
                  {folderNameOf(song) && <span className="library-page__result-folder">{folderNameOf(song)}</span>}
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {!isLoading && !searching && hasContent && (
        <DndContext
          sensors={sensors}
          collisionDetection={libraryCollisionDetection}
          onDragOver={handleDragOver}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
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
                      onRenameSong={renameSong}
                      onRenameFolder={renameFolder}
                      onDeleteFolder={deleteFolder}
                      isDropTarget={dropTarget === folder.id}
                    />
                  ))}
                </SortableContext>
              </div>
            )}

            <section className="library-page__list">
              <RootDropZone isDropTarget={dropTarget === ROOT_CONTAINER_ID}>
                <SortableContext items={rootSongs.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {rootSongs.map((song) => (
                    <DraggableSongRow
                      key={song.id}
                      song={song}
                      onSelect={() => onSelectSong(song.id)}
                      onDelete={() => deleteSong(song.id)}
                      onRename={(title) => renameSong(song.id, title)}
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
