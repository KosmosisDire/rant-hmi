//! Lists that hold each item once under its name, as the project's and a component's do.

/// An item a list holds once under its name.
pub trait Named {
    fn name(&self) -> &str;
}

/// Names each type by its `name` field.
macro_rules! named {
    ($($t:ty),*) => {$(
        impl $crate::list::Named for $t {
            fn name(&self) -> &str {
                &self.name
            }
        }
    )*};
}
pub(crate) use named;

impl Named for String {
    fn name(&self) -> &str {
        self
    }
}

/// Puts `to` in place of the item called `name`, adds it when there is none, or with None
/// removes that item. Gives back the item it replaced. `missing` says why removing nothing fails.
pub fn put<T: Named>(list: &mut Vec<T>, name: &str, to: Option<T>, missing: impl FnOnce() -> String) -> Result<Option<T>, String> {
    let at = list.iter().position(|x| x.name() == name);
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

/// Whether an item other than `own` is called `name`, so `own` cannot take it.
pub fn taken<T: Named>(list: &[T], name: &str, own: &str) -> bool {
    name != own && list.iter().any(|x| x.name() == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_replaces_adds_and_removes_by_name() {
        let mut list = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(put(&mut list, "a", Some("c".into()), String::new), Ok(Some("a".into())));
        assert_eq!(put(&mut list, "d", Some("d".into()), String::new), Ok(None));
        assert_eq!(put(&mut list, "b", None, String::new), Ok(Some("b".into())));
        assert_eq!(put(&mut list, "b", None, || "no b".into()), Err("no b".into()));
        assert_eq!(list, ["c", "d"]);
        assert!(taken(&list, "d", "c") && !taken(&list, "c", "c") && !taken(&list, "e", "c"));
    }
}
