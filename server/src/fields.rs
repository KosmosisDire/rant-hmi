//! Which fields of an import's value something reads: the paths code reads, as `reads.js` finds
//! them, typed against the import's schema into a tree that cuts a value down to those fields.

use std::collections::BTreeMap;

use rant::FieldType;

use crate::mesh::codec::{Shape, bare};
use crate::value::{Records, Value};

/// A path's step to each item of a list.
pub const ITEM: &str = "[]";

/// What is read of a value: all of it, or some of its fields, each with what is read of it. A
/// list's items share one tree, so `points` keeping `x` keeps each point's x, and a list of
/// lists shares it with its lists' items, keeping as much as any level reads.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Keep {
    All,
    Some(BTreeMap<String, Keep>),
}

impl Keep {
    pub fn none() -> Keep {
        Keep::Some(BTreeMap::new())
    }

    /// What `paths`, each the steps after an import's name, read of a value made of `shapes`.
    /// A step past a field to a name its type lacks, as a method, reads that field whole.
    pub fn typed(shapes: &[Shape], paths: &[Vec<String>]) -> Keep {
        // a bare type, as a plain number, has no fields to leave out
        if bare(shapes).is_some() {
            return Keep::All;
        }
        let mut keep = Keep::none();
        for p in paths {
            keep.add(shapes, p);
        }
        keep
    }

    /// Reads `steps` of a struct of `members`, this its tree.
    fn add(&mut self, members: &[Shape], steps: &[String]) {
        let Keep::Some(fields) = self else { return };
        let Some(step) = steps.first() else {
            *self = Keep::All;
            return;
        };
        match members.iter().find(|s| s.field.name == *step) {
            Some(s) => fields.entry(step.clone()).or_insert_with(Keep::none).field(s, &steps[1..]),
            None => *self = Keep::All,
        }
    }

    /// Reads `steps` of the field `s`, this its tree. A list whose items have fields reads
    /// them after `[]`, and only how many there are by `length`.
    fn field(&mut self, s: &Shape, steps: &[String]) {
        let Some(step) = steps.first() else {
            *self = Keep::All;
            return;
        };
        match (s.field.kind, s.element()) {
            (FieldType::Struct, _) => self.add(&s.members, steps),
            (_, Some(e)) if has_fields(e) => match step.as_str() {
                ITEM => self.field(e, &steps[1..]),
                "length" => {}
                _ => *self = Keep::All,
            },
            _ => *self = Keep::All,
        }
    }

    /// Adds what `other` reads to what this reads.
    pub fn merge(&mut self, other: Keep) {
        let Keep::Some(fields) = self else { return };
        let Keep::Some(more) = other else {
            *self = Keep::All;
            return;
        };
        for (name, keep) in more {
            match fields.get_mut(&name) {
                Some(mine) => mine.merge(keep),
                None => {
                    fields.insert(name, keep);
                }
            }
        }
    }

    /// Whether this reads all that `other` does.
    pub fn covers(&self, other: &Keep) -> bool {
        match (self, other) {
            (Keep::All, _) => true,
            (Keep::Some(_), Keep::All) => false,
            (Keep::Some(mine), Keep::Some(theirs)) => theirs.iter().all(|(name, keep)| mine.get(name).is_some_and(|m| m.covers(keep))),
        }
    }

    /// Only the `shapes` this keeps, so a value decodes without the rest.
    pub fn shapes(&self, shapes: &[Shape]) -> Vec<Shape> {
        match self {
            Keep::Some(fields) if bare(shapes).is_none() => shapes.iter().filter_map(|s| Some(fields.get(&s.field.name)?.kept(s))).collect(),
            _ => shapes.to_vec(),
        }
    }

    /// The shape `s` with only what this keeps of it, a list's element with the same.
    fn kept(&self, s: &Shape) -> Shape {
        let members = match s.element() {
            Some(e) => vec![self.kept(e)],
            None => self.shapes(&s.members),
        };
        Shape { members, ..s.clone() }
    }

    /// The paths that read what this keeps of a value made of `shapes`, each the steps after
    /// the name, so a screen can tell which fields come without knowing their types.
    pub fn paths(&self, shapes: &[Shape]) -> Vec<Vec<String>> {
        let mut out = Vec::new();
        self.walk(shapes, &mut Vec::new(), &mut out);
        out
    }

    /// Adds the paths under `at` to `out`, this the tree of a struct of `members`.
    fn walk(&self, members: &[Shape], at: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
        let Keep::Some(fields) = self else { return out.push(at.clone()) };
        for s in members {
            let Some(keep) = fields.get(&s.field.name) else { continue };
            at.push(s.field.name.clone());
            keep.walk_one(s, at, out);
            at.pop();
        }
    }

    /// Adds the paths under `at` to `out`, this the tree of the field `s`.
    fn walk_one(&self, s: &Shape, at: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
        match (self, s.element()) {
            // a list kept with none of its items' fields is read by its length
            (Keep::Some(items), Some(_)) if items.is_empty() => {
                at.push("length".to_owned());
                out.push(at.clone());
                at.pop();
            }
            (Keep::Some(_), Some(e)) => {
                at.push(ITEM.to_owned());
                self.walk_one(e, at, out);
                at.pop();
            }
            _ => self.walk(&s.members, at, out),
        }
    }

    /// `value` with only the fields this keeps.
    pub fn cut(&self, value: &Value) -> Value {
        let Keep::Some(fields) = self else { return value.clone() };
        match value {
            Value::Map(m) => Value::Map(m.iter().filter_map(|(k, v)| Some((k.clone(), fields.get(k)?.cut(v)))).collect()),
            Value::List(items) => Value::List(items.iter().map(|i| self.cut(i)).collect()),
            Value::Records(r) => {
                let columns = r.columns().iter().filter_map(|(k, c)| Some((k.clone(), fields.get(k)?.cut(c)))).collect();
                // records keeping none of their fields are only as many empty ones
                Records::new(r.len(), columns).map_or_else(|| Value::List(vec![Value::Map(Vec::new()); r.len()]), Value::Records)
            }
            other => other.clone(),
        }
    }
}

/// Whether a list's items have fields to leave out: records, or lists of them.
fn has_fields(e: &Shape) -> bool {
    match e.element() {
        Some(inner) => has_fields(inner),
        None => e.field.kind == FieldType::Struct,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::codec::{decode, encode, shapes};
    use crate::value::value;

    /// A value as a screen reads it, whichever way it is kept.
    fn plain(v: &Value) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    fn paths(list: &[&str]) -> Vec<Vec<String>> {
        list.iter().map(|p| p.split('.').filter(|s| !s.is_empty()).map(str::to_owned).collect()).collect()
    }

    const SCAN: &str = "Point { x: f32, y: f32, z: f32, intensity: u16 }
Place { x: f64, y: f64 }
Spot { at: Place, size: f32 }
Scan { stamp: f64, name: string<16>, pose: Place, points: Point[], ranges: f32[], spots: Spot[] }
";

    /// A lidar scan, written and read back as the mesh would bring it.
    fn scan() -> (Vec<Shape>, Value) {
        let node = rant::Node::new("hmi_fields_test", rant::NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap();
        let schema = node.schema(SCAN).unwrap();
        let shapes = shapes(&schema);
        let written = value!({
            "stamp": 7.0,
            "name": "front",
            "pose": { "x": 1.0, "y": 2.0 },
            "points": [ { "x": 1.0, "y": 2.0, "z": 3.0, "intensity": 9 }, { "x": -1.0, "y": 0.5, "z": 0.25, "intensity": 300 } ],
            "ranges": [ 0.5, 2.0 ],
            "spots": [ { "at": { "x": 3.0, "y": 4.0 }, "size": 0.5 } ]
        });
        let read = decode(&schema.view(&encode(&schema, &shapes, &written).unwrap()), &shapes);
        (shapes, read)
    }

    #[test]
    fn paths_keep_the_fields_they_name() {
        let (shapes, read) = scan();
        let keep = Keep::typed(&shapes, &paths(&["pose.x", "points.[].x", "points.[].z"]));
        let cut = keep.cut(&read);
        assert_eq!(plain(&cut), plain(&value!({ "pose": { "x": 1.0 }, "points": [ { "x": 1.0, "z": 3.0 }, { "x": -1.0, "z": 0.25 } ] })));
        assert!(matches!(cut.get("points"), Some(Value::Records(_))), "points stay columns");
    }

    #[test]
    fn a_name_the_type_lacks_reads_what_came_before_whole() {
        let (shapes, _) = scan();
        let all = |p: &[&str]| Keep::typed(&shapes, &paths(p));
        // a method of a field, an index into a struct, and a field of a list's own
        assert_eq!(all(&["name.toUpperCase"]), Keep::Some([("name".to_owned(), Keep::All)].into()));
        assert_eq!(all(&["pose.[]"]), Keep::Some([("pose".to_owned(), Keep::All)].into()));
        assert_eq!(all(&["points.x"]), Keep::Some([("points".to_owned(), Keep::All)].into()));
        assert_eq!(all(&["ranges.[]"]), Keep::Some([("ranges".to_owned(), Keep::All)].into()));
        assert_eq!(all(&["toString"]), Keep::All);
        assert_eq!(all(&[""]), Keep::All);
        // a path read whole covers one inside it
        assert_eq!(all(&["pose", "pose.x"]), Keep::Some([("pose".to_owned(), Keep::All)].into()));
    }

    #[test]
    fn a_lists_length_keeps_its_items_without_their_fields() {
        let (shapes, read) = scan();
        let keep = Keep::typed(&shapes, &paths(&["points.length"]));
        assert_eq!(plain(&keep.cut(&read)), plain(&value!({ "points": [ {}, {} ] })));
        let both = Keep::typed(&shapes, &paths(&["points.length", "points.[].intensity"]));
        assert_eq!(plain(&both.cut(&read)), plain(&value!({ "points": [ { "intensity": 9 }, { "intensity": 300 } ] })));
    }

    #[test]
    fn readers_add_up_and_a_value_decodes_with_only_what_they_read() {
        let (shapes, read) = scan();
        let typed = |p: &[&str]| Keep::typed(&shapes, &paths(p));
        let mut keep = Keep::none();
        keep.merge(typed(&["pose.x", "points.length"]));
        keep.merge(typed(&["points.[].z", "name"]));
        assert_eq!(keep, typed(&["pose.x", "points.[].z", "name"]));
        assert!(keep.covers(&typed(&["points.[].z"])) && !keep.covers(&typed(&["points.[].x"])) && !keep.covers(&Keep::All));
        // decoding with only those shapes gives what cutting the whole value does
        let node = rant::Node::new("hmi_fields_decode", rant::NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap();
        let schema = node.schema(SCAN).unwrap();
        let bytes = encode(&schema, &shapes, &read).unwrap();
        for keep in [keep.clone(), typed(&["points.length", "spots.[].at.y"]), Keep::none(), Keep::All] {
            assert_eq!(plain(&decode(&schema.view(&bytes), &keep.shapes(&shapes))), plain(&keep.cut(&read)), "{keep:?}");
        }
        // a bare type decodes whole, whatever reads it
        assert_eq!(Keep::none().shapes(&crate::mesh::codec::shapes(&node.schema("f64").unwrap())).len(), 1);
        keep.merge(Keep::All);
        assert_eq!(keep, Keep::All);
    }

    #[test]
    fn lists_of_lists_keep_what_any_level_reads() {
        let node = rant::Node::new("hmi_fields_nested", rant::NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap();
        let schema = node.schema("Leg { speed: f32, pts: Double2[], name: string }
Route { id: u32, segments: Leg[], grid: Double2[][] }").unwrap();
        let shapes = shapes(&schema);
        let written = value!({ "id": 1, "segments": [ { "speed": 0.5, "pts": [ { "x": 1.0, "y": 2.0 } ], "name": "a" }, { "speed": 1.0, "pts": [], "name": "b" } ],
                              "grid": [ [ { "x": 1.0, "y": 2.0 } ], [] ] });
        let read = decode(&schema.view(&encode(&schema, &shapes, &written).unwrap()), &shapes);
        assert_eq!(plain(&read), plain(&written));
        let typed = |p: &[&str]| Keep::typed(&shapes, &paths(p));
        let keep = typed(&["segments.[].pts.[].x", "grid.[].[].y", "segments.[].name.length"]);
        assert_eq!(plain(&keep.cut(&read)), plain(&value!({ "segments": [ { "pts": [ { "x": 1.0 } ], "name": "a" }, { "pts": [], "name": "b" } ], "grid": [ [ { "y": 2.0 } ], [] ] })));
        let bytes = encode(&schema, &shapes, &read).unwrap();
        for k in [keep.clone(), typed(&["segments.length"]), typed(&["grid.[].length"]), Keep::none()] {
            assert_eq!(plain(&decode(&schema.view(&bytes), &k.shapes(&shapes))), plain(&k.cut(&read)), "{k:?}");
            assert_eq!(Keep::typed(&shapes, &k.paths(&shapes)), k);
        }
    }

    #[test]
    fn a_keeps_paths_read_it_again() {
        let (shapes, _) = scan();
        let typed = |p: &[&str]| Keep::typed(&shapes, &paths(p));
        let shown = |k: &Keep| k.paths(&shapes).iter().map(|p| p.join(".")).collect::<Vec<_>>();
        let keep = typed(&["pose.x", "points.[].z", "name.length", "spots.length", "spots.[].at.y"]);
        assert_eq!(shown(&keep), ["name", "pose.x", "points.[].z", "spots.[].at.y"]);
        assert_eq!(shown(&typed(&["ranges.length", "spots.length"])), ["ranges", "spots.length"]);
        assert_eq!(shown(&Keep::All), [""]);
        assert!(shown(&Keep::none()).is_empty());
        for k in [keep, typed(&["spots.length", "pose"]), Keep::All, Keep::none()] {
            assert_eq!(Keep::typed(&shapes, &k.paths(&shapes)), k);
        }
    }
}
