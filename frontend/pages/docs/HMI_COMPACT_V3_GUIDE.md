# HMI Compact V3 — Hướng dẫn vận hành và kiểm thử

## Mục tiêu thiết kế

Bản V3 làm gọn giao diện bằng cách đưa các thông tin vận hành quan trọng lên một lớp Level‑1 compact:

- `SYNC CONTRACT`: máy thật và NX MCD đã đồng bộ chưa.
- `CONTROL OWNER`: nguồn pose đang được Control Selector chọn.
- `G-CODE CHECK`: kết quả kiểm tra còn hợp lệ hay đã stale.
- `RUN PERMISSION`: trạng thái khóa/mở chạy thật.
- `SYNC EPOCH`: mã phiên đồng bộ hiện tại.

3D Twin vẫn là lớp hiển thị read-only. Nó không được phát lệnh điều khiển FluidNC hoặc NX MCD.

## Quy trình vận hành khuyến nghị

1. Mở `/monitor` để xem trạng thái tổng thể.
2. Thực hiện Home & Sync trên máy thật thông qua backend.
3. Kiểm tra `SYNC CONTRACT = MACHINE_NX_SYNCED`.
4. Chạy G-code CHECK. Nếu `sync_epoch_id` thay đổi sau CHECK, kết quả CHECK phải coi là `STALE`.
5. Chỉ chạy thật khi `RUN PERMISSION = READY`.
6. Khi có alarm/collision/unsynced, xử lý nguyên nhân trước; không dựa vào 3D viewer để quyết định chạy.

## Ý nghĩa các nguồn Control Selector

| Source | Ý nghĩa | Có phải máy thật? |
|---|---|---|
| `stream_fluidnc` | Pose từ FluidNC khi máy thật đang chạy | Có |
| `idle_fluidnc` | Mirror MPos khi máy idle/jog | Có |
| `matlab_check` | Quỹ đạo mô phỏng/check | Không |
| `home_sync` | Backend đang đưa NX/3D về pose đồng bộ home | Không phải gia công |
| `estop` | Trạng thái ưu tiên safety | Không chạy |

## Cách kiểm tra giao diện đã gọn

Chạy test static:

```bash
PYTHONPATH=. python -m unittest tests.test_hmi_compact_v3_static -v
```

Test này kiểm tra:

- Header/sidebar/AI panel có giới hạn kích thước compact.
- Home không còn dùng ba khối lớn `hmi-overview-grid`.
- Monitor chỉ còn một dải context compact trước process data.
- Control gate còn một hàng checklist compact trên desktop.
- Có hướng dẫn vận hành đi kèm trong UI và trong tài liệu.

## Deploy lên Render

1. Copy toàn bộ project V3 lên repo đang deploy.
2. Redeploy service Render.
3. Kiểm tra các đường dẫn:
   - `/`
   - `/monitor`
   - `/control`
   - `/cnc3d`
   - `/static/docs/HMI_COMPACT_V3_GUIDE.md`
4. Nếu trình duyệt cache CSS cũ, hard refresh bằng `Ctrl + F5`.

## Quy tắc sửa tiếp

- Không thêm thêm banner lớn nếu thông tin có thể nằm trong compact strip.
- Màu đỏ/vàng chỉ dùng cho alarm, stale, blocked, collision.
- Các nút điều khiển thật không được đặt trong iframe 3D.
- Mọi dữ liệu realtime lên frontend phải đi qua Control Selector và `/ws/pose`.
