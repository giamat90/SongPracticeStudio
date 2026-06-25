import { useState } from "react";
import LibraryPage from "./pages/LibraryPage";
import AnalyzerPage from "./pages/AnalyzerPage";

type Route = { page: "library" } | { page: "analyzer"; songId: string };

function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });

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
    </div>
  );
}

export default App;
