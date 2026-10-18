#pragma once

#include "versus/video/aspect_fit.h"
#include "versus/video/window_capture.h"
#include <QImage>
#include <QPainter>
#include <cstring>
#include <vector>

namespace versus::platform::detail {

// Visit straight-BGRA row pairs with exactly the old Qt aspect-fit geometry.
// Capture often already supplies the fitted size. In that case, use the owned
// capture bytes directly, or a two-row scratch buffer for letterbox borders.
// Retain Qt's existing raster scaling when the image really needs resizing.
template<class Convert>
bool withFittedBgraRows(const video::CapturedFrame &frame, int width, int height,
                       Convert convert) {
    if (width < 2 || height < 2 || width > 8192 || height > 8192 || (width & 1) || (height & 1) ||
        frame.format != video::CapturedFrame::Format::BGRA || frame.width <= 0 || frame.height <= 0 ||
        frame.width > 8192 || frame.height > 8192 || frame.stride < frame.width * 4 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * frame.height) return false;
    const auto fit = video::computeAspectFitRect(frame.width, frame.height, width, height);
    if (fit.width == frame.width && fit.height == frame.height) {
        if (frame.width == width && frame.height == height) {
            for (int y = 0; y < height; y += 2)
                convert(frame.data.data() + static_cast<size_t>(y) * frame.stride,
                        frame.data.data() + static_cast<size_t>(y + 1) * frame.stride, y);
        } else {
            const size_t stride = static_cast<size_t>(width) * 4;
            std::vector<uint8_t> pair(stride * 2);
            for (int y = 0; y < height; y += 2) {
                // Odd border positions must participate in the same 2x2
                // chroma average as ordinary image pixels. Do not round them.
                std::memset(pair.data(), 0, pair.size());
                for (int row = 0; row < 2; ++row) {
                    const int sourceY = y + row - fit.y;
                    if (sourceY >= 0 && sourceY < frame.height)
                        std::memcpy(pair.data() + row * stride + fit.x * 4,
                                    frame.data.data() + static_cast<size_t>(sourceY) * frame.stride,
                                    static_cast<size_t>(frame.width) * 4);
                }
                convert(pair.data(), pair.data() + stride, y);
            }
        }
        return true;
    }
    QImage input(frame.data.data(), frame.width, frame.height, frame.stride, QImage::Format_RGB32);
    QImage fitted(width, height, QImage::Format_RGB32);
    if (fitted.isNull()) return false;
    fitted.fill(Qt::black);
    {
        QPainter painter(&fitted);
        painter.drawImage(QRect(fit.x, fit.y, fit.width, fit.height), input);
    }
    for (int y = 0; y < height; y += 2)
        convert(fitted.constScanLine(y), fitted.constScanLine(y + 1), y);
    return true;
}

} // namespace versus::platform::detail
