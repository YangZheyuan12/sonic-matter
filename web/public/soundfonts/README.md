# 本地音色库

## 放在哪里

把允许再分发的 WAV 根音样本放在当前目录：

```text
D:\myProjects\腾讯音乐黑客松\web\public\soundfonts\
```

目前 `manifest.json` 默认查找：

- `piano-c4.wav`：钢琴，根音 MIDI 60 / C4
- `strings-c4.wav`：弦乐，根音 MIDI 60 / C4
- `bass-c2.wav`：低音，根音 MIDI 36 / C2
- `pad-c4.wav`：氛围铺底，根音 MIDI 60 / C4
- `bell-c5.wav`：钟琴/玻璃音色，根音 MIDI 72 / C5

文件名可以自定义，但要同步修改 `manifest.json` 的 `url` 和 `rootPitch`。播放时会按照根音对 WAV 做实时变调；缺文件时自动退回浏览器合成器，不会导致工程无法播放。

## 可以从哪里找

建议优先搜索这些项目的官方发布页或官方仓库：

- **FreePats**：适合寻找可自由使用的乐器采样与 SFZ 音色。
- **University of Iowa Electronic Music Studios Musical Instrument Samples**：适合挑选单件乐器的 WAV 样本。
- **Salamander Grand Piano**：适合钢琴演示；下载后挑选一个 C4 附近的干声样本。
- **GeneralUser GS**：通用 GM SoundFont，适合快速试听整体音色，但它通常是 `.sf2`，当前版本不能直接在浏览器里解析，需要先导出 WAV，或后续接入 SoundFont 播放引擎。
- **Pianobook / Decent Sampler 社区音色**：音色选择多，但每个库的授权不同，只能逐个核对许可证。

不要把来路不明的商业音色直接提交到 GitHub 或部署到公共网站。下载后请把许可证、署名要求或原始说明文件也放在这个目录，例如 `LICENSE-<library>.txt`。

## 现在没有自动下载

本项目没有把第三方音色直接打包进仓库，也没有偷偷下载音源。这样做是为了避免把不可再分发的采样上传到你的项目。你下载并确认许可证后，将 WAV 复制到上述目录，刷新页面即可使用。

## 后续升级路线

如果希望直接加载完整 `.sf2`，可以把 SoundFont 播放引擎接入 `src/audio/projectAudio.ts`，再把 `.sf2` 放到 `public/soundfonts/`。这会比当前的 5 个根音 WAV 方案更完整，但会增加包体积、加载时间和许可证审查成本。
