//! Which fields of an import's value something reads: the paths code reads, as `reads.js` finds
//! them, typed against the import's schema into a tree that cuts a value down to those fields.

use std::collections::BTreeMap;

use rant::FieldType;

use crate::mesh::codec::Shape;
use crate::value::{Records, Value};

/// A path's step to each item of a list.
pub const ITEM: &str = "[]";

/// What is read of a value: all of it, or some of its fields, each with what is read of it. A
/// list's items share one tree, so `points` keeping `x` keeps each point's x.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Keep {
    All,
    Some(BTreeMap<String, Keep>),
}

impl Keep {
    fn none() -> Keep {
        Keep::Some(BTreeMap::new())
    }

    /// What `paths`, each the steps after an import's name, read of a value made of `shapes`.
    /// A step past a field to a name its type lacks, as a method, reads that field whole.
    pub fn typed(shapes: &[Shape], paths: &[Vec<String>]) -> Keep {
        // a bare type, as a plain number, has no fields to leave out
        if matches!(shapes, [one] if one.field.name.is_empty()) {
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

    /// Reads `steps` of the field `s`, this its tree. A list of records reads its items' fields
    /// after `[]`, and only how many there are by `length`.
    fn field(&mut self, s: &Shape, steps: &[String]) {
        let Some(step) = steps.first() else {
            *self = Keep::All;
            return;
        };
        match s.field.kind {
            FieldType::Struct => self.add(&s.members, steps),
            FieldType::Array | FieldType::VArray if s.field.elem == FieldType::Struct => match step.as_str() {
                ITEM => self.add(&s.members, &steps[1..]),
                "length" => {}
                _ => *self = Keep::All,
            },
            _ => *self = Keep::All,
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

    /// A lidar scan and a picture, written and read back as the mesh would bring them.
    fn scan() -> (Vec<Shape>, Value) {
        let node = rant::Node::new("hmi_fields_test", rant::NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap();
        let schema = node.schema("Point { x: f32, y: f32, z: f32, intensity: u16 }
Place { x: f64, y: f64 }
Scan { stamp: f64, name: string<16>, pose: Place, points: Point[], ranges: f32[] }
").unwrap();
        let shapes = shapes(&schema);
        let written = value!({
            "stamp": 7.0,
            "name": "front",
            "pose": { "x": 1.0, "y": 2.0 },
            "points": [ { "x": 1.0, "y": 2.0, "z": 3.0, "intensity": 9 }, { "x": -1.0, "y": 0.5, "z": 0.25, "intensity": 300 } ],
            "ranges": [ 0.5, 2.0 ]
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
}
