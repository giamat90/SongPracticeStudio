import { useState } from "react";
import LibraryPage from "./pages/LibraryPage";
import PracticeRoom from "./pages/PracticeRoom";

type Route = { page: "library" } | { page: "practice"; songId: string };

function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });

  return (
    <div className="app">
      {route.page === "library" ? (
        <LibraryPage
          onSelectSong={(songId) => setRoute({ page: "practice", songId })}
        />
      ) : (
        <PracticeRoom
          songId={route.songId}
          onBack={() => setRoute({ page: "library" })}
        />
      )}
    </div>
  );
}

export default App;
