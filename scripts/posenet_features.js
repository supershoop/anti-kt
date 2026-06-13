const tf = require("@tensorflow/tfjs");
const posenet = require("@tensorflow-models/posenet");
const readline = require("readline");

let loadedModel = null;
let loadedSettingsKey = null;

function settingsKey(settings) {
  return JSON.stringify(settings);
}

async function getModel(settings) {
  await tf.setBackend("cpu");
  await tf.ready();

  const key = settingsKey(settings);
  if (loadedModel && loadedSettingsKey === key) {
    return loadedModel;
  }

  loadedModel = await posenet.load({
    architecture: settings.architecture || "MobileNetV1",
    outputStride: settings.outputStride || 16,
    inputResolution: settings.inputResolution || 257,
    multiplier: settings.multiplier || 0.75
  });
  loadedSettingsKey = key;
  return loadedModel;
}

function normalizeImage(imageTensor, inputResolution) {
  return tf.tidy(() => {
    const resized = padAndResizeTo(imageTensor, inputResolution);
    return resized.toFloat();
  });
}

function padAndResizeTo(imageTensor, inputResolution) {
  const [height, width] = imageTensor.shape;
  const targetAspect = 1;
  const imageAspect = width / height;
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;

  if (imageAspect < targetAspect) {
    left = Math.round(0.5 * (targetAspect * height - width));
    right = Math.round(0.5 * (targetAspect * height - width));
  } else {
    top = Math.round(0.5 * ((1 / targetAspect) * width - height));
    bottom = Math.round(0.5 * ((1 / targetAspect) * width - height));
  }

  const padded = tf.pad3d(imageTensor, [[top, bottom], [left, right], [0, 0]]);
  return tf.image.resizeBilinear(padded, [inputResolution, inputResolution]);
}

async function extractFeatures(request) {
  const settings = request.settings || {};
  const inputResolution = settings.inputResolution || 257;
  const model = await getModel(settings);
  const pixels = new Uint8Array(Buffer.from(request.image, "base64"));

  const features = tf.tidy(() => {
    const image = tf.tensor3d(pixels, [request.height, request.width, 3], "int32");
    const input = normalizeImage(image, inputResolution);
    const poseOutputs = model.baseModel.predict(input);
    const heatmapScores = poseOutputs.heatmapScores || poseOutputs[0];
    const offsets = poseOutputs.offsets || poseOutputs[1];
    const flattened = tf.concat([heatmapScores, offsets], 2).flatten();
    return Array.from(flattened.dataSync());
  });

  if (features.length !== 14739) {
    throw new Error(`Expected 14739 PoseNet features, got ${features.length}`);
  }
  return features;
}

async function main() {
  if (process.argv.includes("--check")) {
    await getModel({
      architecture: "MobileNetV1",
      outputStride: 16,
      inputResolution: 257,
      multiplier: 0.75
    });
    console.log("PoseNet feature extractor ready");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    try {
      const request = JSON.parse(line);
      const features = await extractFeatures(request);
      process.stdout.write(`${JSON.stringify({ features })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
