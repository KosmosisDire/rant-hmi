//! Lists that hold each item once under its key, as the project's and a component's do: a name,
//! an import's alias or a rule's id.

/// An item a list holds once under its key.
pub trait Keyed {
    fn key(&self) -> &str;
}

/// Keys each type by its `name` field.
macro_rules! by_name {
    ($($t:ty),*) => {$(
        impl $crate::list::Keyed for $t {
            fn key(&self) -> &str {
                &self.name
            }
        }
    )*};
}
pub(crate) use by_name;

impl Keyed for String {
    fn key(&self) -> &str {
        self
    }
}

/// Puts `to` in place of the item under `key`, adds it when there is none, or with None removes
/// that item. Gives back the item it replaced. `missing` says why removing nothing fails.
pub fn put<T: Keyed>(list: &mut Vec<T>, key: &str, to: Option<T>, missing: impl FnOnce() -> String) -> Result<Option<T>, String> {
    let at = list.iter().position(|x| x.key() == key);
    Ok(match (at, to) {
        (Some(at), Some(to)) => Some(std::mem::replace(&mut list[at], to)),
        (Some(at), None) => Some(list.remove(at)),
        (None, Some(to)) => {
            list.push(to);
            None
        }
        (None, None) => return Err(missing()),
    })
}

/// Whether an item other than `own` is under `key`, so `own` cannot take it.
pub fn taken<T: Keyed>(list: &[T], key: &str, own: &str) -> bool {
    key != own && list.iter().any(|x| x.key() == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_replaces_adds_and_removes_by_key() {
        let mut list = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(put(&mut list, "a", Some("c".into()), String::new), Ok(Some("a".into())));
        assert_eq!(put(&mut list, "d", Some("d".into()), String::new), Ok(None));
        assert_eq!(put(&mut list, "b", None, String::new), Ok(Some("b".into())));
        assert_eq!(put(&mut list, "b", None, || "no b".into()), Err("no b".into()));
        assert_eq!(list, ["c", "d"]);
        assert!(taken(&list, "d", "c") && !taken(&list, "c", "c") && !taken(&list, "e", "c"));
    }
}
