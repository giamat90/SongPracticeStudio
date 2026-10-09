use std::fs;
use std::path::PathBuf;

#[cfg(test)]
thread_local! {
    static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Root data directory: ~/.songpracticestudio/
pub fn app_data_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(root) = TEST_ROOT.with(|r| r.borrow().clone()) {
        fs::create_dir_all(&root).expect("could not create test data dir");
        return root;
    }
    let base = dirs::home_dir().expect("could not determine home directory");
    let dir = base.join(".songpracticestudio");
    fs::create_dir_all(&dir).expect("could not create app data dir");
    dir
}

/// Library directory: ~/.songpracticestudio/library/
pub fn library_dir() -> PathBuf {
    let dir = app_data_dir().join("library");
    fs::create_dir_all(&dir).expect("could not create library dir");
    dir
}

/// Per-song directory: ~/.songpracticestudio/library/{song_id}/
pub fn song_dir(song_id: &str) -> PathBuf {
    let dir = library_dir().join(song_id);
    fs::create_dir_all(&dir).expect("could not create song dir");
    dir
}

/// Test support: redirects the data directory of the *current thread* to a
/// throwaway temp dir, so tests that exercise the real library/take code paths
/// never touch the developer's ~/.songpracticestudio and can run in parallel
/// without locking.
#[cfg(test)]
pub mod test_support {
    use super::TEST_ROOT;
    use std::path::{Path, PathBuf};

    pub struct TestHome {
        root: PathBuf,
    }

    impl TestHome {
        pub fn new() -> Self {
            let root = std::env::temp_dir().join(format!("sps-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("create test home");
            TEST_ROOT.with(|r| *r.borrow_mut() = Some(root.clone()));
            Self { root }
        }

        pub fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            TEST_ROOT.with(|r| *r.borrow_mut() = None);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TestHome;
    use super::*;

    #[test]
    fn all_paths_live_under_the_data_dir() {
        let home = TestHome::new();
        assert_eq!(app_data_dir(), home.path());
        assert_eq!(library_dir(), home.path().join("library"));
        assert_eq!(song_dir("abc"), home.path().join("library").join("abc"));
    }

    #[test]
    fn directories_are_created_on_demand() {
        let _home = TestHome::new();
        assert!(song_dir("fresh").is_dir());
    }

    #[test]
    fn each_thread_has_its_own_home() {
        let a = TestHome::new();
        let b_root = std::thread::spawn(|| {
            let b = TestHome::new();
            b.path().to_path_buf()
        })
        .join()
        .unwrap();
        assert_ne!(a.path(), b_root);
        assert_eq!(app_data_dir(), a.path());
    }

    #[test]
    fn dropping_the_home_removes_it() {
        let root = {
            let home = TestHome::new();
            song_dir("x");
            home.path().to_path_buf()
        };
        assert!(!root.exists());
    }
}
