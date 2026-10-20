// A designer shows the camera as video with what a detector found over it, in the editor
// alone: a video of the camera, which the transcoder makes H264 and the backend plays over
// WebRTC, and a drawing over it in the picture's pixels. Running, the rectangle sits on the
// part the video shows, give or take how far the part moves while the video travels.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  await d.tab("Data");
  for (const name of ["Camera", "Detections"]) {
    const row = await d.meshRow(`Cell/${name}`);
    if ((await row.locator(".row-add").count()) > 0) await row.locator(".row-add").click();
    await eventually(() => hmi.state.imports.some((i) => i.alias === name), `${name} imported`);
  }

  await d.addPage("Camera video");
  const box = { x: "44", y: "44", w: "480", h: "360" };
  const video = await d.add("video", { Name: "camera", ...box, Source: "Camera" });
  await d.add("drawing", { Name: "overlay", ...box, "View box": "`0 0 ${Camera.width} ${Camera.height}`", Fit: '"meet"' });
  await d.addShape("rect", {
    Name: "found",
    x: "item.min.x",
    y: "item.min.y",
    Width: "item.max.x - item.min.x",
    Height: "item.max.y - item.min.y",
    Fill: '"none"',
    Stroke: "#4a8fd6",
    Thickness: "2",
  });
  await d.setField("Repeat", "Detections.boxes");

  await d.tab("Run");
  const player = page.locator(`.run-layer:not([hidden]) .el[data-id="${video}"] video`);
  // the transcoder probes a new camera for 3 s, and the first frame waits for a keyframe
  await eventually(async () => (await player.evaluate((v) => v.videoWidth)) === 160, "the camera's video on the page", 20000);

  // the orange part's middle in the video, against the rectangle's middle, in picture pixels
  const apart = await page.evaluate((id) => {
    const v = document.querySelector(`.run-layer:not([hidden]) .el[data-id="${id}"] video`);
    const canvas = Object.assign(document.createElement("canvas"), { width: v.videoWidth, height: v.videoHeight });
    const g = canvas.getContext("2d");
    g.drawImage(v, 0, 0);
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let [n, sx, sy] = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 170 && px[i + 1] > 90 && px[i + 1] < 190 && px[i + 2] < 110) {
        n++;
        sx += (i / 4) % canvas.width;
        sy += Math.floor(i / 4 / canvas.width);
      }
    }
    const rect = document.querySelector('.run-layer:not([hidden]) [data-name="found"]').getBoundingClientRect();
    const b = v.getBoundingClientRect();
    const k = Math.min(b.width / v.videoWidth, b.height / v.videoHeight);
    const [left, top] = [b.left + (b.width - v.videoWidth * k) / 2, b.top + (b.height - v.videoHeight * k) / 2];
    const [rx, ry] = [(rect.left + rect.width / 2 - left) / k, (rect.top + rect.height / 2 - top) / k];
    return n < 50 ? null : Math.hypot(sx / n - rx, sy / n - ry);
  }, video);
  check(apart !== null, "no part in the video's frame");
  check(apart < 12, `the rectangle is ${apart.toFixed(1)} px from the part in the video`);
}
