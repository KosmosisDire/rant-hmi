fn main() {
    // the Rant icon on the file a person downloads and starts
    println!("cargo::rerun-if-changed=launcher.rc");
    println!("cargo::rerun-if-changed=../icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("launcher.rc", embed_resource::NONE).manifest_required().unwrap();
    }
}
