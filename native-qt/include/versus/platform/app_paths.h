#pragma once

#include <QString>

namespace versus::platform {

// Mac paths are independent of the Finder/terminal working directory and of
// application metadata, since logging starts before QApplication is created.
QString logDirectory();
QString dataDirectory();

} // namespace versus::platform
