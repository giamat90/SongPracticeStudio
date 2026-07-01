import { useEffect, useState } from "react";
import LibraryPage from "./pages/LibraryPage";
import AnalyzerPage from "./pages/AnalyzerPage";
import UpdateDialog from "./components/updater/UpdateDialog";
import { useUpdaterStore } from "./stores/updater";

type Route = { page: "library" } | { page: "analyzer"; songId: string };

function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  return (
    <div className="app">
      {route.page === "library" ? (
        <LibraryPage
          onSelectSong={(songId) => setRoute({ page: "analyzer", songId })}
        />
      ) : (
        <AnalyzerPage
          songId={route.songId}
          onBack={() => setRoute({ page: "library" })}
        />
      )}
      <UpdateDialog />
    </div>
  );
}

export default App;
