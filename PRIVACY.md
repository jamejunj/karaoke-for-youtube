# Privacy Policy — Karaoke for YouTube™

*Last updated: 15 October 2026 · applies to version 1.5.0 and later*

[ภาษาไทยอยู่ด้านล่าง](#นโยบายความเป็นส่วนตัว--คาราโอเกะสำหรับ-youtube)

## Summary

Karaoke for YouTube™ has no accounts, no analytics and no advertising. It does not sell or share your data. The developer does not run a server and receives no data from the extension.

## Data stored on your device

These are kept in your browser with `chrome.storage.local`. They are never sent to the developer:

- **Settings:** key, vocal removal, speed, lyrics display options, colours and interface language.
- **Lyrics choices for each video:** which lyrics or caption track you picked, timing adjustments, lyrics you synced or pasted yourself, and the position and size of the lyrics panel. These are stored under the YouTube video ID.
- **Song queue:** the video ID, title and channel name of each queued video.

Uninstalling the extension removes all of this data.

## Data sent to other services

| When | Sent to | What is sent |
|---|---|---|
| **Lyrics** is switched on | [LRCLIB](https://lrclib.net) (lrclib.net) | The current video's title, channel name and length, to find matching lyrics. Searches you type yourself are also sent there. |
| A video has captions (CC) | YouTube (youtube.com) | The extension downloads the video's captions to use as lyrics, the same way YouTube's player does. To do this it may briefly switch the player's CC on and back off. |
| You add a video to the queue by its link | YouTube (youtube.com) | The video link, sent to YouTube's public oEmbed service to get the video's title and channel name. |

Nothing is sent to LRCLIB while **Lyrics** is switched off. Requests to LRCLIB and YouTube are covered by their own privacy policies.

Audio processing (key change, vocal removal and speed) happens entirely in your browser. No audio is recorded or uploaded.

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Saves the settings, lyrics choices and queue described above. |
| `scripting` | Reconnects to YouTube tabs that were already open when the extension was updated, by re-adding the extension's own bundled scripts. No remote code is used. |
| `contextMenus` | Adds "Add to karaoke queue" to the right-click menu on YouTube videos. |
| Access to `youtube.com` | Processes the video's audio, shows lyrics on the player, loads captions and plays the next song in the queue. |
| Access to `lrclib.net` | Looks up lyrics. |

## Changes to this policy

If this policy changes, the new version will be published in this file with a new "Last updated" date. The full history is in the repository's commit log.

## Contact

Questions or concerns: please [open an issue](https://github.com/jamejunj/karaoke-for-youtube/issues) on GitHub.

---

# นโยบายความเป็นส่วนตัว — คาราโอเกะสำหรับ YouTube™

*อัปเดตล่าสุด: 15 ตุลาคม 2026 · ใช้กับเวอร์ชัน 1.5.0 ขึ้นไป*

## สรุป

ส่วนขยายนี้ไม่มีระบบบัญชีผู้ใช้ ไม่มีระบบวิเคราะห์การใช้งาน และไม่มีโฆษณา ไม่ขายหรือแบ่งปันข้อมูลของคุณ ผู้พัฒนาไม่มีเซิร์ฟเวอร์ และไม่ได้รับข้อมูลใด ๆ จากส่วนขยาย

## ข้อมูลที่เก็บไว้ในเครื่องของคุณ

ข้อมูลเหล่านี้เก็บไว้ในเบราว์เซอร์ด้วย `chrome.storage.local` และไม่ถูกส่งไปให้ผู้พัฒนา:

- **การตั้งค่า:** คีย์ การตัดเสียงร้อง ความเร็ว ตัวเลือกการแสดงเนื้อร้อง สี และภาษาของหน้าจอ
- **เนื้อร้องที่เลือกไว้ของแต่ละวิดีโอ:** เนื้อร้องหรือคำบรรยายที่เลือก ค่าเลื่อนเวลา เนื้อร้องที่ซิงก์หรือวางเอง และตำแหน่งกับขนาดของแผงเนื้อร้อง ข้อมูลนี้เก็บโดยอ้างอิงรหัสวิดีโอ YouTube
- **คิวเพลง:** รหัสวิดีโอ ชื่อวิดีโอ และชื่อช่องของแต่ละเพลงในคิว

เมื่อถอนการติดตั้งส่วนขยาย ข้อมูลทั้งหมดนี้จะถูกลบ

## ข้อมูลที่ส่งไปยังบริการอื่น

| เมื่อไร | ส่งไปที่ | ข้อมูลที่ส่ง |
|---|---|---|
| เปิดใช้**เนื้อร้อง** | [LRCLIB](https://lrclib.net) (lrclib.net) | ชื่อวิดีโอ ชื่อช่อง และความยาวของวิดีโอที่กำลังเล่น เพื่อค้นหาเนื้อร้องที่ตรงกัน คำค้นหาที่คุณพิมพ์เองก็จะถูกส่งไปที่นี่เช่นกัน |
| วิดีโอมีคำบรรยาย (CC) | YouTube (youtube.com) | ส่วนขยายดาวน์โหลดคำบรรยายของวิดีโอมาใช้เป็นเนื้อร้อง แบบเดียวกับที่ player ของ YouTube โหลด ระหว่างนี้อาจเปิด CC ใน player สั้น ๆ แล้วปิดคืน |
| เพิ่มวิดีโอเข้าคิวจากลิงก์ | YouTube (youtube.com) | ลิงก์วิดีโอ ส่งไปที่บริการ oEmbed สาธารณะของ YouTube เพื่อขอชื่อวิดีโอและชื่อช่อง |

ถ้าปิด**เนื้อร้อง**ไว้ จะไม่มีการส่งข้อมูลใด ๆ ไปที่ LRCLIB คำขอที่ส่งไปที่ LRCLIB และ YouTube อยู่ภายใต้นโยบายความเป็นส่วนตัวของบริการนั้น ๆ

การประมวลผลเสียง (ปรับคีย์ ตัดเสียงร้อง และปรับความเร็ว) ทำในเบราว์เซอร์ทั้งหมด ไม่มีการบันทึกหรืออัปโหลดเสียง

## สิทธิ์ที่ขอ

| สิทธิ์ | เหตุผล |
|---|---|
| `storage` | บันทึกการตั้งค่า เนื้อร้องที่เลือก และคิวเพลงตามที่ระบุข้างต้น |
| `scripting` | เชื่อมต่อแท็บ YouTube ที่เปิดค้างไว้ตอนอัปเดตส่วนขยายใหม่ โดยใส่ script ที่มาพร้อมกับส่วนขยายกลับเข้าไป ไม่มีการใช้โค้ดจากภายนอก |
| `contextMenus` | เพิ่มคำสั่ง "เพิ่มเข้าคิวคาราโอเกะ" ในเมนูคลิกขวาบนวิดีโอ YouTube |
| สิทธิ์เข้าถึง `youtube.com` | ประมวลผลเสียงของวิดีโอ แสดงเนื้อร้องบน player โหลดคำบรรยาย และเล่นเพลงถัดไปในคิว |
| สิทธิ์เข้าถึง `lrclib.net` | ค้นหาเนื้อร้อง |

## การเปลี่ยนแปลงนโยบาย

ถ้านโยบายนี้มีการเปลี่ยนแปลง ฉบับใหม่จะเผยแพร่ในไฟล์นี้พร้อมวันที่ "อัปเดตล่าสุด" ใหม่ ดูประวัติการแก้ไขทั้งหมดได้จาก commit log ของ repository

## ติดต่อ

หากมีคำถามหรือข้อกังวล โปรด[เปิด issue](https://github.com/jamejunj/karaoke-for-youtube/issues) บน GitHub

---

YouTube is a trademark of Google LLC. This extension is not affiliated with or endorsed by Google or YouTube.
YouTube เป็นเครื่องหมายการค้าของ Google LLC ส่วนขยายนี้ไม่ได้เกี่ยวข้องกับหรือได้รับการรับรองจาก Google หรือ YouTube
