// 시험용: 연주 JSON(make_perf.py)을 맥 내장 피아노 음색(gs_instruments.dls)으로 녹음처럼 만든다 (로컬 전용)
//   swift tools/render_perf.swift 연주.json 출력.wav [잔향 0~100, 기본 25]
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 3 else { print("사용법: swift render_perf.swift 연주.json 출력.wav [잔향]"); exit(1) }
let perf = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: Any]
let notes = perf["notes"] as! [[String: Any]]
let wet = args.count > 3 ? Float(args[3])! : 25

struct Ev { let t: Double; let on: Bool; let midi: UInt8; let vel: UInt8 }
var evs: [Ev] = []
for n in notes {
    let t = (n["t"] as! NSNumber).doubleValue, d = (n["dur"] as! NSNumber).doubleValue
    let m = UInt8((n["midi"] as! NSNumber).intValue), v = UInt8((n["vel"] as! NSNumber).intValue)
    evs.append(Ev(t: t, on: true, midi: m, vel: v))
    evs.append(Ev(t: t + d, on: false, midi: m, vel: 0))
}
evs.sort { $0.t < $1.t || ($0.t == $1.t && !$0.on && $1.on) }
let total = (evs.last?.t ?? 0) + 2.5

let sr = 48000.0
let engine = AVAudioEngine()
let sampler = AVAudioUnitSampler()
let reverb = AVAudioUnitReverb()
engine.attach(sampler)
engine.attach(reverb)
let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
try engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 512)
engine.connect(sampler, to: reverb, format: nil)
engine.connect(reverb, to: engine.mainMixerNode, format: nil)
let dls = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
try sampler.loadSoundBankInstrument(at: dls, program: 0, bankMSB: 0x79, bankLSB: 0)
reverb.loadFactoryPreset(.mediumRoom)
reverb.wetDryMix = wet
try engine.start()

let out = try AVAudioFile(forWriting: URL(fileURLWithPath: args[2]), settings: fmt.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 512)!
var idx = 0
var frames: AVAudioFramePosition = 0
let totalFrames = AVAudioFramePosition(total * sr)
while frames < totalFrames {
    let tEnd = Double(frames + 512) / sr
    while idx < evs.count && evs[idx].t < tEnd {
        let e = evs[idx]
        if e.on { sampler.startNote(e.midi, withVelocity: e.vel, onChannel: 0) } else { sampler.stopNote(e.midi, onChannel: 0) }
        idx += 1
    }
    let st = try engine.renderOffline(512, to: buf)
    guard st == .success else { print("렌더 실패 \(st)"); exit(1) }
    try out.write(from: buf)
    frames += 512
}
out.close()
print("\(args[2]): \(String(format: "%.1f", total))초")
